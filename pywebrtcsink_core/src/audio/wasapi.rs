use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use rtrb::Producer;
use windows::core::GUID;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, WaitForSingleObject,
};

use crate::metrics::EngineMetrics;

const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

pub struct WasapiDeviceInfo {
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct WasapiCaptureLoopback {
    running: Arc<AtomicBool>,
    thread_handle: Option<JoinHandle<()>>,
    pub device_info: WasapiDeviceInfo,
}

/// Pausa de reintento que sigue respondiendo a stop() rapido (10 x 50ms).
fn sleep_retry(running: &Arc<AtomicBool>) {
    for _ in 0..10 {
        if !running.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Push de un bloque interleaved al ring, SIEMPRE alineado a frames (multiplo
/// de `channels`): un sample suelto desplazaria la paridad L/R de todo el
/// stream. En overflow descarta el resto del bloque (seguira alineado porque
/// el ring nunca queda con un resto impar) y cuenta FRAMES, no samples.
/// Devuelve cuantos frames entraron.
fn push_block(producer: &mut Producer<f32>, metrics: &EngineMetrics, block: &[f32], channels: usize) -> usize {
    debug_assert_eq!(block.len() % channels, 0);
    let mut written = 0usize;
    while written < block.len() {
        let avail = producer.slots();
        if avail < channels {
            break;
        }
        let n = (block.len() - written).min(avail - (avail % channels));
        if n == 0 {
            break;
        }
        for &s in &block[written..written + n] {
            let _ = producer.push(s); // infalible: avail >= n
        }
        written += n;
    }
    let dropped = block.len() - written;
    if dropped > 0 {
        metrics.frames_dropped_ring.fetch_add((dropped / channels) as u64, Ordering::Relaxed);
    }
    written / channels
}

/// Reloj de cadencia del stream: frames que DEBERIAN haber entrado al ring
/// desde t0 vs los que entraron. El keepalive inyecta silencio SOLO por el
/// deficit: el audio real atrasado consume el deficit solo, sin que nadie
/// apile ceros encima. Y si los relojes (IAudioClient vs Instant) derrapan,
/// resync en vez de crecer latencia para siempre.
struct StreamClock {
    t0: std::time::Instant,
    pushed: u64,
    rate: u32,
}

impl StreamClock {
    fn new(rate: u32) -> Self {
        Self { t0: std::time::Instant::now(), pushed: 0, rate }
    }

    fn deficit_frames(&self) -> usize {
        let expected = (self.t0.elapsed().as_secs_f64() * self.rate as f64) as u64;
        expected.saturating_sub(self.pushed) as usize
    }

    fn credit(&mut self, frames: usize) {
        self.pushed += frames as u64;
    }

    /// Deriva > 1 s de audio = los relojes no miden lo mismo; reanclar.
    fn resync_if_drifted(&mut self) {
        if self.deficit_frames() > self.rate as usize {
            self.t0 = std::time::Instant::now();
            self.pushed = 0;
        }
    }
}

/// Igual que sleep_retry pero sigue alimentando silencio: el cliente no se
/// queda seco durante el backoff de re-enumeracion (unplug / cambio de
/// default). Usa el ultimo formato conocido; el bump de generation posterior
/// hace que el encoder drene este tail.
fn retry_wait_pumping(
    running: &Arc<AtomicBool>,
    producer: &mut Producer<f32>,
    metrics: &EngineMetrics,
    tick_tx: &std::sync::mpsc::SyncSender<()>,
    rate: u32,
    channels: usize,
) {
    if rate == 0 {
        sleep_retry(running);
        return;
    }
    let zeros = vec![0.0f32; (rate / 50) as usize * channels.max(1)];
    for _ in 0..25 {
        if !running.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        let pushed = push_block(producer, metrics, &zeros, channels.max(1));
        metrics.pcm_silent_injected.fetch_add(pushed as u64, Ordering::Relaxed);
        let _ = tick_tx.try_send(());
    }
}

impl WasapiCaptureLoopback {
    pub fn start(
        mut ring_producer: Producer<f32>,
        running: Arc<AtomicBool>,
        metrics: Arc<EngineMetrics>,
        dev_rate: Arc<AtomicU32>,
        dev_channels: Arc<AtomicU32>,
        dev_mask: Arc<AtomicU32>,
        dev_generation: Arc<AtomicU64>,
        tick_tx: std::sync::mpsc::SyncSender<()>,
    ) -> anyhow::Result<Self> {
        let (info_tx, info_rx) = std::sync::mpsc::sync_channel::<anyhow::Result<WasapiDeviceInfo>>(1);
        let is_running = running.clone();

        let thread_handle = std::thread::Builder::new()
            .name("wasapi-loopback-rt".to_string())
            .spawn(move || {
                unsafe {
                    let com_init = CoInitializeEx(None, COINIT_MULTITHREADED);
                    if let Err(e) = com_init.ok() {
                        let _ = info_tx.send(Err(anyhow::anyhow!("CoInitializeEx failed: {:?}", e)));
                        return;
                    }

                    let mut task_index = 0u32;
                    let mmcss_name = windows::core::w!("Audio");
                    let mmcss_handle = match AvSetMmThreadCharacteristicsW(mmcss_name, &mut task_index) {
                        Ok(handle) => Some(handle),
                        Err(_) => None,
                    };

                    let mut first_init = true;

                    // Loop de dispositivo: si el endpoint se invalida (unplug,
                    // cambio de default), se re-enumera solo en vez de quedarse
                    // en silencio eterno. El formato nuevo se publica por
                    // atomics + generation para que el encoder se adapte.
                    'device: while is_running.load(Ordering::Relaxed) {
                        let enumerator: IMMDeviceEnumerator = match CoCreateInstance(
                            &MMDeviceEnumerator,
                            None,
                            CLSCTX_ALL,
                        ) {
                            Ok(enum_dev) => enum_dev,
                            Err(e) => {
                                if first_init {
                                    let _ = info_tx.send(Err(anyhow::anyhow!("CoCreateInstance MMDeviceEnumerator failed: {:?}", e)));
                                    break 'device;
                                }
                                sleep_retry(&is_running);
                                continue 'device;
                            }
                        };

                        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) {
                            Ok(dev) => dev,
                            Err(e) => {
                                if first_init {
                                    let _ = info_tx.send(Err(anyhow::anyhow!("GetDefaultAudioEndpoint failed: {:?}", e)));
                                    break 'device;
                                }
                                sleep_retry(&is_running);
                                continue 'device;
                            }
                        };

                        let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                            Ok(client) => client,
                            Err(e) => {
                                if first_init {
                                    let _ = info_tx.send(Err(anyhow::anyhow!("device.Activate IAudioClient failed: {:?}", e)));
                                    break 'device;
                                }
                                sleep_retry(&is_running);
                                continue 'device;
                            }
                        };

                        let pwfx = match audio_client.GetMixFormat() {
                            Ok(format_ptr) => format_ptr,
                            Err(e) => {
                                if first_init {
                                    let _ = info_tx.send(Err(anyhow::anyhow!("GetMixFormat failed: {:?}", e)));
                                    break 'device;
                                }
                                sleep_retry(&is_running);
                                continue 'device;
                            }
                        };

                        let sample_rate = (*pwfx).nSamplesPerSec;
                        let channels = (*pwfx).nChannels;
                        let bits_per_sample = (*pwfx).wBitsPerSample;
                        // dwChannelMask solo existe en EXTENSIBLE; si no hay, 0
                        // y el encoder cae al downmix fallback (primeros 2 canales).
                        let channel_mask = if (*pwfx).wFormatTag == 0xFFFE /* WAVE_FORMAT_EXTENSIBLE */ {
                            let ext = pwfx as *const WAVEFORMATEXTENSIBLE;
                            std::ptr::addr_of!((*ext).dwChannelMask).read_unaligned()
                        } else {
                            0
                        };
                        let is_float = if (*pwfx).wFormatTag == 3 /* WAVE_FORMAT_IEEE_FLOAT */ {
                            true
                        } else if (*pwfx).wFormatTag == 0xFFFE /* WAVE_FORMAT_EXTENSIBLE */ {
                            let ext = pwfx as *const WAVEFORMATEXTENSIBLE;
                            std::ptr::addr_of!((*ext).SubFormat).read_unaligned() == SUBTYPE_IEEE_FLOAT
                        } else {
                            false
                        };

                        // ponytail: GetMixFormat en shared mode es float32 siempre; si no,
                        // avisar una vez por (re)enumeracion y soltar buffers (audio en silencio).
                        if !(is_float && bits_per_sample == 32) {
                            eprintln!("[wasapi] formato inesperado ({} bits, no float32): audio se descartara", bits_per_sample);
                        }

                        // Initializing IAudioClient in Loopback + Event Callback mode
                        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
                        let buffer_duration_100ns = 200_000; // 20ms buffer

                        if let Err(e) = audio_client.Initialize(
                            AUDCLNT_SHAREMODE_SHARED,
                            flags,
                            buffer_duration_100ns,
                            0,
                            pwfx,
                            None,
                        ) {
                            CoTaskMemFree(Some(pwfx as *const std::ffi::c_void));
                            if first_init {
                                let _ = info_tx.send(Err(anyhow::anyhow!("audio_client.Initialize failed: {:?}", e)));
                                break 'device;
                            }
                            sleep_retry(&is_running);
                            continue 'device;
                        }
                        CoTaskMemFree(Some(pwfx as *const std::ffi::c_void));

                        let event_handle: HANDLE = match CreateEventW(None, false, false, None) {
                            Ok(h) => h,
                            Err(e) => {
                                if first_init {
                                    let _ = info_tx.send(Err(anyhow::anyhow!("CreateEventW failed: {:?}", e)));
                                    break 'device;
                                }
                                sleep_retry(&is_running);
                                continue 'device;
                            }
                        };

                        if let Err(e) = audio_client.SetEventHandle(event_handle) {
                            let _ = CloseHandle(event_handle);
                            if first_init {
                                let _ = info_tx.send(Err(anyhow::anyhow!("SetEventHandle failed: {:?}", e)));
                                break 'device;
                            }
                            sleep_retry(&is_running);
                            continue 'device;
                        }

                        let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                            Ok(service) => service,
                            Err(e) => {
                                let _ = CloseHandle(event_handle);
                                if first_init {
                                    let _ = info_tx.send(Err(anyhow::anyhow!("audio_client.GetService IAudioCaptureClient failed: {:?}", e)));
                                    break 'device;
                                }
                                sleep_retry(&is_running);
                                continue 'device;
                            }
                        };

                        if let Err(e) = audio_client.Start() {
                            let _ = CloseHandle(event_handle);
                            if first_init {
                                let _ = info_tx.send(Err(anyhow::anyhow!("audio_client.Start failed: {:?}", e)));
                                break 'device;
                            }
                            sleep_retry(&is_running);
                            continue 'device;
                        }

                        // Dispositivo listo: publicar formato y avisar (solo la primera vez).
                        dev_rate.store(sample_rate, Ordering::SeqCst);
                        dev_channels.store(channels as u32, Ordering::SeqCst);
                        dev_mask.store(channel_mask, Ordering::SeqCst);
                        dev_generation.fetch_add(1, Ordering::SeqCst);
                        eprintln!(
                            "[wasapi] endpoint: {}Hz {}ch mask=0x{:x} ({})",
                            sample_rate, channels, channel_mask,
                            if channels > 2 { "downmix ITU-R BS.775" } else { "directo" }
                        );
                        if first_init {
                            let _ = info_tx.send(Ok(WasapiDeviceInfo {
                                sample_rate,
                                channels,
                            }));
                            first_init = false;
                        }

                        let channel_count = channels as usize;
                        // ponytail: WASAPI loopback NO dispara eventos si el endpoint
                        // no procesa audio (PC silenciosa = stream muerto). La
                        // inyeccion de ceros es por DEFICIT del StreamClock, no por
                        // deadline ciego: el audio real que llega tarde paga el
                        // deficit el mismo y no se apilan ceros encima.
                        let frames_per_tick = (sample_rate / 50) as usize;
                        let mut clock = StreamClock::new(sample_rate);
                        let mut device_lost = false;

                        // ponytail: default timer resolution de Windows es 15.6ms y con ella
                        // WaitForSingleObject duerme de mas, matando la cadencia de 50 fps.
                        windows::Win32::Media::timeBeginPeriod(1);

                        while is_running.load(Ordering::Relaxed) && !device_lost {
                            clock.resync_if_drifted();

                            // Drenar lo que haya (evento = "hay datos").
                            let wait_res = WaitForSingleObject(event_handle, 5);
                            if wait_res == WAIT_OBJECT_0 {
                                let mut p_data: *mut u8 = std::ptr::null_mut();
                                let mut num_frames = 0u32;
                                let mut flags = 0u32;

                                loop {
                                    let hr = capture_client.GetBuffer(
                                        &mut p_data,
                                        &mut num_frames,
                                        &mut flags,
                                        None,
                                        None,
                                    );

                                    if let Err(e) = hr {
                                        let code = e.code().0 as u32;
                                        // DEVICE_INVALIDATED / SERVICE_NOT_RUNNING:
                                        // re-enumerar. Resto: transitorio — Reset
                                        // en sitio, sin pagar 500ms de backoff.
                                        let fatal = code == 0x88890004 || code == 0x88890010;
                                        let recovered = !fatal
                                            && audio_client.Stop().is_ok()
                                            && audio_client.Reset().is_ok()
                                            && audio_client.Start().is_ok();
                                        if !recovered {
                                            device_lost = true;
                                        }
                                        break;
                                    }
                                    if num_frames == 0 {
                                        break;
                                    }

                                    let total_samples = (num_frames as usize) * channel_count;
                                    metrics.frames_captured.fetch_add(num_frames as u64, Ordering::Relaxed);

                                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                                        let zeros = vec![0.0f32; total_samples];
                                        let pushed = push_block(&mut ring_producer, &metrics, &zeros, channel_count);
                                        clock.credit(pushed);
                                        metrics.pcm_silent_injected.fetch_add(pushed as u64, Ordering::Relaxed);
                                    } else if is_float && bits_per_sample == 32 {
                                        let float_slice = std::slice::from_raw_parts(p_data as *const f32, total_samples);
                                        let pushed = push_block(&mut ring_producer, &metrics, float_slice, channel_count);
                                        clock.credit(pushed);
                                    }
                                    // ponytail: GetMixFormat en shared mode SIEMPRE es float32;
                                    // formato raro = aviso unico arriba; este buffer se suelta.

                                    let _ = capture_client.ReleaseBuffer(num_frames);

                                    // Tick coalescido al llegar audio real: si aqui no se
                                    // avisa, el encoder solo se despierta por el timeout de
                                    // 50ms y sale en rafagas de 2-3 frames (P1).
                                    let _ = tick_tx.try_send(());
                                }
                            }

                            // Keepalive POR DEFICIT: si faltan >= 2 ticks de audio real,
                            // inyectar solo lo que falta (cap 2 ticks por pasada). El
                            // audio real atrasado paga el deficit el mismo; nunca se
                            // apilan ceros encima de samples reales.
                            let deficit = clock.deficit_frames();
                            if deficit >= 2 * frames_per_tick {
                                let inject = deficit.min(2 * frames_per_tick);
                                let zeros = vec![0.0f32; inject * channel_count];
                                let pushed = push_block(&mut ring_producer, &metrics, &zeros, channel_count);
                                clock.credit(pushed);
                                metrics.pcm_silent_injected.fetch_add(pushed as u64, Ordering::Relaxed);
                                let _ = tick_tx.try_send(());
                            }
                        }

                        let _ = audio_client.Stop();
                        let _ = CloseHandle(event_handle);
                        // ponytail: restaurar resolution (process-wide).
                        windows::Win32::Media::timeEndPeriod(1);

                        if device_lost && is_running.load(Ordering::Relaxed) {
                            // Seguir alimentando silencio durante el backoff para que
                            // el cliente no se quede seco mientras se re-enumera.
                            retry_wait_pumping(&is_running, &mut ring_producer, &metrics, &tick_tx, sample_rate, channel_count);
                            continue 'device;
                        }
                        break 'device;
                    }

                    if let Some(h) = mmcss_handle {
                        let _ = AvRevertMmThreadCharacteristics(h);
                    }
                    CoUninitialize();
                }
            })?;

        let device_info = info_rx.recv()??;

        Ok(Self {
            running,
            thread_handle: Some(thread_handle),
            device_info,
        })
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}
