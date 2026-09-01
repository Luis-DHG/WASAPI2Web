use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use rtrb::Producer;
use windows::core::GUID;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, WaitForSingleObject,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

use crate::metrics::EngineMetrics;

const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

pub struct WasapiDeviceInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub is_float: bool,
}

pub struct WasapiCaptureLoopback {
    running: Arc<AtomicBool>,
    thread_handle: Option<JoinHandle<()>>,
    pub device_info: WasapiDeviceInfo,
}

impl WasapiCaptureLoopback {
    pub fn start(
        mut ring_producer: Producer<f32>,
        running: Arc<AtomicBool>,
        metrics: Arc<EngineMetrics>,
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

                    let enumerator: IMMDeviceEnumerator = match CoCreateInstance(
                        &MMDeviceEnumerator,
                        None,
                        CLSCTX_ALL,
                    ) {
                        Ok(enum_dev) => enum_dev,
                        Err(e) => {
                            let _ = info_tx.send(Err(anyhow::anyhow!("CoCreateInstance MMDeviceEnumerator failed: {:?}", e)));
                            CoUninitialize();
                            return;
                        }
                    };

                    let device = match enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) {
                        Ok(dev) => dev,
                        Err(e) => {
                            let _ = info_tx.send(Err(anyhow::anyhow!("GetDefaultAudioEndpoint failed: {:?}", e)));
                            CoUninitialize();
                            return;
                        }
                    };

                    let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                        Ok(client) => client,
                        Err(e) => {
                            let _ = info_tx.send(Err(anyhow::anyhow!("device.Activate IAudioClient failed: {:?}", e)));
                            CoUninitialize();
                            return;
                        }
                    };

                    let pwfx = match audio_client.GetMixFormat() {
                        Ok(format_ptr) => format_ptr,
                        Err(e) => {
                            let _ = info_tx.send(Err(anyhow::anyhow!("GetMixFormat failed: {:?}", e)));
                            CoUninitialize();
                            return;
                        }
                    };

                    let sample_rate = (*pwfx).nSamplesPerSec;
                    let channels = (*pwfx).nChannels;
                    let bits_per_sample = (*pwfx).wBitsPerSample;
                    let is_float = if (*pwfx).wFormatTag == 3 /* WAVE_FORMAT_IEEE_FLOAT */ {
                        true
                    } else if (*pwfx).wFormatTag == 0xFFFE /* WAVE_FORMAT_EXTENSIBLE */ {
                        let ext = pwfx as *const WAVEFORMATEXTENSIBLE;
                        std::ptr::addr_of!((*ext).SubFormat).read_unaligned() == SUBTYPE_IEEE_FLOAT
                    } else {
                        false
                    };

                    let device_info = WasapiDeviceInfo {
                        sample_rate,
                        channels,
                        bits_per_sample,
                        is_float,
                    };

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
                        let _ = info_tx.send(Err(anyhow::anyhow!("audio_client.Initialize failed: {:?}", e)));
                        CoUninitialize();
                        return;
                    }

                    let event_handle: HANDLE = match CreateEventW(None, false, false, None) {
                        Ok(h) => h,
                        Err(e) => {
                            let _ = info_tx.send(Err(anyhow::anyhow!("CreateEventW failed: {:?}", e)));
                            CoUninitialize();
                            return;
                        }
                    };

                    if let Err(e) = audio_client.SetEventHandle(event_handle) {
                        let _ = info_tx.send(Err(anyhow::anyhow!("SetEventHandle failed: {:?}", e)));
                        let _ = CloseHandle(event_handle);
                        CoUninitialize();
                        return;
                    }

                    let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                        Ok(service) => service,
                        Err(e) => {
                            let _ = info_tx.send(Err(anyhow::anyhow!("audio_client.GetService IAudioCaptureClient failed: {:?}", e)));
                            let _ = CloseHandle(event_handle);
                            CoUninitialize();
                            return;
                        }
                    };

                    if let Err(e) = audio_client.Start() {
                        let _ = info_tx.send(Err(anyhow::anyhow!("audio_client.Start failed: {:?}", e)));
                        let _ = CloseHandle(event_handle);
                        CoUninitialize();
                        return;
                    }

                    // Success initializing WASAPI
                    let _ = info_tx.send(Ok(device_info));

                    let channel_count = channels as usize;
                    // ponytail: WASAPI loopback NO dispara eventos si el endpoint
                    // no procesa audio (PC silenciosa = stream muerto). Si el
                    // evento timeoutea 20ms, inyectar 20ms de ceros para mantener
                    // vivo el reloj del encoder (equivalente al keepalive Python).
                    let frames_per_tick = (sample_rate / 50) as usize;
                    let tick_dur = std::time::Duration::from_millis(20);
                    let mut next_deadline = std::time::Instant::now() + tick_dur;

                    // ponytail: default timer resolution de Windows es 15.6ms y con ella
                    // WaitForSingleObject duerme de mas, matando la cadencia de 50 fps.
                    unsafe { windows::Win32::Media::timeBeginPeriod(1) };

                    while is_running.load(Ordering::Relaxed) {
                        let now = std::time::Instant::now();
                        if now >= next_deadline {
                            let mut wait_ms = 5u32;
                            let mut ticks = 0usize;
                            while next_deadline <= now {
                                ticks += 1;
                                next_deadline += tick_dur;
                            }
                            if ticks > 0 {
                                for _ in 0..(ticks * frames_per_tick * channel_count) {
                                    let _ = ring_producer.push(0.0f32);
                                }
                                metrics.pcm_silent_injected
                                    .fetch_add((ticks * frames_per_tick) as u64, Ordering::Relaxed);

                                // Solo esperar datos si acabamos de inyectar suficiente.
                                let sleep_ms = next_deadline
                                    .duration_since(now)
                                    .min(tick_dur)
                                    .as_millis() as u32;
                                wait_ms = sleep_ms.max(1);
                            }

                            let wait_res = WaitForSingleObject(event_handle, wait_ms);
                            if wait_res == WAIT_OBJECT_0 {
                                next_deadline = std::time::Instant::now() + tick_dur;
                            } else {
                                continue;
                            }
                        }

                        let wait_res = WaitForSingleObject(event_handle, 5);
                        if wait_res != WAIT_OBJECT_0 {
                            continue;
                        }

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

                            if hr.is_err() || num_frames == 0 {
                                break;
                            }

                            // Data real llego; el deadline se re-arma en el proximo ciclo.
                            next_deadline = std::time::Instant::now() + tick_dur;

                            let total_samples = (num_frames as usize) * channel_count;
                            metrics.frames_captured.fetch_add(num_frames as u64, Ordering::Relaxed);

                            if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                                // AUDCLNT_BUFFERFLAGS_SILENT: Inject PCM zeros
                                metrics.pcm_silent_injected.fetch_add(num_frames as u64, Ordering::Relaxed);
                                for _ in 0..total_samples {
                                    let _ = ring_producer.push(0.0f32);
                                }
                            } else if is_float && bits_per_sample == 32 {
                                let float_slice = std::slice::from_raw_parts(p_data as *const f32, total_samples);
                                for &sample in float_slice {
                                    let _ = ring_producer.push(sample);
                                }
                            } else if bits_per_sample == 16 {
                                let i16_slice = std::slice::from_raw_parts(p_data as *const i16, total_samples);
                                for &sample in i16_slice {
                                    let float_sample = (sample as f32) / 32768.0f32;
                                    let _ = ring_producer.push(float_sample);
                                }
                            } else if bits_per_sample == 24 {
                                // 24-bit PCM in 3 bytes per sample
                                let bytes = std::slice::from_raw_parts(p_data, total_samples * 3);
                                for chunk in bytes.chunks_exact(3) {
                                    let sample_i32 = ((chunk[0] as i32) | ((chunk[1] as i32) << 8) | ((chunk[2] as i8 as i32) << 16)) << 8;
                                    let float_sample = (sample_i32 as f32) / 2147483648.0f32;
                                    let _ = ring_producer.push(float_sample);
                                }
                            } else if bits_per_sample == 32 {
                                let i32_slice = std::slice::from_raw_parts(p_data as *const i32, total_samples);
                                for &sample in i32_slice {
                                    let float_sample = (sample as f32) / 2147483648.0f32;
                                    let _ = ring_producer.push(float_sample);
                                }
                            }

                            let _ = capture_client.ReleaseBuffer(num_frames);
                        }
                    }

                    let _ = audio_client.Stop();
                    let _ = CloseHandle(event_handle);
                    // ponytail: restaurar resolution (process-wide).
                    unsafe { windows::Win32::Media::timeEndPeriod(1) };
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
