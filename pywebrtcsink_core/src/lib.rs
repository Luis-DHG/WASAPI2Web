use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use pyo3::prelude::*;
use tokio::sync::{broadcast, watch};

use crate::audio::resampler::LinearResampler;
use crate::audio::wasapi::WasapiCaptureLoopback;
use crate::codec::opus::OpusPipeline;
use crate::metrics::EngineMetrics;
use crate::server::ws::run_websocket_server;

// pub: las integration tests los usan (tests/channel_parity.rs, encoder_pipeline.rs).
pub mod audio;
pub mod codec;
mod metrics;
mod server;

/// Downmix a stereo (ITU-R BS.775): el canal i del bloque interleaved es el
/// i-esimo bit set de `mask` (LSB primero). Sin mask usable → primeros 2 ch.
#[doc(hidden)] // pub solo para tests/ — no es interface de la fachada
pub fn downmix_to_stereo(input: &[f32], channels: usize, mask: u32, out: &mut Vec<f32>) {
    // Posiciones de speaker: bit bajo = canal antes. FL, FR, C, LFE, BL, BR, ..., SL, SR.
    const FL: u32 = 0x1;
    const FR: u32 = 0x2;
    const FC: u32 = 0x4;
    const LFE: u32 = 0x8;
    const BL: u32 = 0x10;
    const BR: u32 = 0x20;
    const SL: u32 = 0x200;
    const SR: u32 = 0x400;

    let usable = (mask & (FL | FR)) == (FL | FR) && channels == mask.count_ones() as usize;
    if !usable {
        // Fallback: primeros dos canales tal cual.
        for frame in input.chunks(channels) {
            out.push(frame[0]);
            out.push(if channels > 1 { frame[1] } else { frame[0] });
        }
        return;
    }

    // Indice interleaved de cada posicion de speaker que existe en la mask.
    let mut idx_of = [usize::MAX; 18];
    let mut idx = 0usize;
    for bit in 0..32 {
        if mask & (1u32 << bit) != 0 && idx < 18 {
            idx_of[idx] = bit as usize;
            idx += 1;
        }
    }
    // inv: dado bit de speaker → indice en el frame
    let at = |frame: &[f32], speaker: u32| -> f32 {
        let bit = speaker.trailing_zeros() as usize;
        for (i, &b) in idx_of.iter().enumerate().take(channels) {
            if b == bit {
                return frame[i];
            }
        }
        0.0
    };

    let g = std::f32::consts::FRAC_1_SQRT_2; // 0.7071
    for frame in input.chunks(channels) {
        let fl = at(frame, FL);
        let fr = at(frame, FR);
        let c = at(frame, FC) * g;
        let _ = LFE; // LFE se descarta por diseno
        let l_sur = (at(frame, BL) + at(frame, SL)) * g;
        let r_sur = (at(frame, BR) + at(frame, SR)) * g;
        out.push((fl + c + l_sur).clamp(-1.0, 1.0));
        out.push((fr + c + r_sur).clamp(-1.0, 1.0));
    }
}

#[pyclass]
pub struct PyWasapiSinkEngine {
    running: Arc<AtomicBool>,
    shutdown_tx: Option<watch::Sender<bool>>,
    metrics: Arc<EngineMetrics>,
    main_thread: Option<JoinHandle<()>>,
    device_sample_rate: Arc<std::sync::atomic::AtomicU32>,
    device_channels: Arc<std::sync::atomic::AtomicU32>,
    device_channel_mask: Arc<std::sync::atomic::AtomicU32>,
    device_generation: Arc<std::sync::atomic::AtomicU64>,
}

#[pymethods]
impl PyWasapiSinkEngine {
    #[new]
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            shutdown_tx: None,
            metrics: EngineMetrics::new(),
            main_thread: None,
            device_sample_rate: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            device_channels: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            device_channel_mask: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            device_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    pub fn start(&mut self, py: Python<'_>, host: String, port: u16, bitrate: i32) -> PyResult<()> {
        if self.running.load(Ordering::SeqCst) {
            return Err(pyo3::exceptions::PyRuntimeError::new_err("Audio engine is already running"));
        }

        // Rango legal de libopus para stereo: 500 bps - 512 kbps.
        // Sin esto, un bitrate invalido moria dentro del hilo encoder con un
        // eprintln invisible y el engine quedaba "running" sin emitir nada.
        if !(500..=512_000).contains(&bitrate) {
            return Err(pyo3::exceptions::PyValueError::new_err(format!(
                "bitrate {} fuera de rango (500..=512000 bps; ~64k-192k recomendado para stereo)",
                bitrate
            )));
        }

        self.running.store(true, Ordering::SeqCst);
        let is_running = self.running.clone();
        let metrics = self.metrics.clone();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        self.shutdown_tx = Some(shutdown_tx);

        let dev_rate_atom = self.device_sample_rate.clone();
        let dev_chan_atom = self.device_channels.clone();
        let dev_mask_atom = self.device_channel_mask.clone();
        let dev_gen_atom = self.device_generation.clone();

        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

        let handle = std::thread::Builder::new()
            .name("pywebrtcsink-main".to_string())
            .spawn(move || {
                // 1. RingBuffer for raw PCM samples: 2 sec @ 48k stereo
                // (headroom ante stalls del encoder; ~768 KiB de f32).
                let (ring_producer, mut ring_consumer) = rtrb::RingBuffer::new(48000 * 2 * 2);
                let (audio_tx, _) = broadcast::channel::<Arc<Vec<u8>>>(64);
                // Tick capture->encoder: despertar event-driven al llegar audio
                // (antes: busy-poll de 1 ms). Coalescido: "hay datos en el ring".
                let (tick_tx, tick_rx) = std::sync::mpsc::sync_channel::<()>(8);

                // 2. Start WASAPI Capture Loopback
                let mut wasapi = match WasapiCaptureLoopback::start(
                    ring_producer,
                    is_running.clone(),
                    metrics.clone(),
                    dev_rate_atom.clone(),
                    dev_chan_atom.clone(),
                    dev_mask_atom.clone(),
                    dev_gen_atom.clone(),
                    tick_tx,
                ) {
                    Ok(w) => {
                        // El hilo WASAPI ya publico rate/canales en los atomics
                        // antes de responder info (wasapi.rs).
                        let _ = ready_tx.send(Ok(()));
                        w
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("WASAPI Init error: {:?}", e)));
                        return;
                    }
                };

                let in_rate = wasapi.device_info.sample_rate;
                let in_channels = wasapi.device_info.channels as usize;

                // 3. Encoder thread
                let encoder_running = is_running.clone();
                let encoder_metrics = metrics.clone();
                let enc_audio_tx = audio_tx.clone();
                let enc_dev_rate = dev_rate_atom.clone();
                let enc_dev_channels = dev_chan_atom.clone();
                let enc_dev_mask = dev_mask_atom.clone();
                let enc_dev_gen = dev_gen_atom.clone();

                let encoder_thread = std::thread::Builder::new()
                    .name("opus-encoder-rt".to_string())
                    .spawn(move || {
                        let mut opus = match OpusPipeline::new(bitrate) {
                            Ok(op) => op,
                            Err(e) => {
                                eprintln!("Failed to initialize Opus encoder: {:?}", e);
                                return;
                            }
                        };

                        let mut resampler = LinearResampler::new(in_rate, 48000, in_channels);
                        let mut cur_channels = in_channels;
                        let mut cur_mask: u32 = enc_dev_mask.load(Ordering::SeqCst);
                        let mut last_gen = enc_dev_gen.load(Ordering::SeqCst);
                        let mut raw_chunk = Vec::with_capacity(1920);
                        let mut resampled_chunk = Vec::with_capacity(1920);
                        let mut stereo_chunk = Vec::with_capacity(1920);
                        let mut encoded_packet = vec![0u8; 1275 + 8]; // Max Opus payload + 8B header

                        while encoder_running.load(Ordering::Relaxed) {
                            // El formato puede cambiar si captura re-enumera
                            // tras device lost: recrear resampler, descartar
                            // resto viejo y drenar el ring (todo lo pusheado
                            // tras el bump de generation ya es formato nuevo).
                            let gen = enc_dev_gen.load(Ordering::SeqCst);
                            if gen != last_gen {
                                last_gen = gen;
                                let new_rate = enc_dev_rate.load(Ordering::SeqCst).max(1);
                                cur_channels = enc_dev_channels.load(Ordering::SeqCst).max(1) as usize;
                                cur_mask = enc_dev_mask.load(Ordering::SeqCst);
                                resampler = LinearResampler::new(new_rate, 48000, cur_channels);
                                opus.discard_pending();
                                while ring_consumer.pop().is_ok() {}
                            }

                            raw_chunk.clear();
                            {
                                // Pop alineado a frame completo: un sample
                                // suelto desplazaria la paridad L/R de todo
                                // lo que sigue. El resto (<1 frame) queda en
                                // el ring para la proxima vuelta.
                                let avail = ring_consumer.slots();
                                let take = (avail / cur_channels).min(960) * cur_channels;
                                if take > 0 {
                                    if let Ok(chunk) = ring_consumer.read_chunk(take) {
                                        let (first, second) = chunk.as_slices();
                                        raw_chunk.extend_from_slice(first);
                                        raw_chunk.extend_from_slice(second);
                                        chunk.commit_all();
                                    }
                                }
                            }

                            if raw_chunk.is_empty() {
                                // ponytail: park hasta tick de captura o timeout
                                // de seguridad (si captura muere, el hilo sigue
                                // chequeando running). No busy-poll.
                                let _ = tick_rx.recv_timeout(std::time::Duration::from_millis(50));
                                continue;
                            }

                            // ponytail: captura pudo re-enumerar durante el pop
                            // → chunk mezcla formatos; descartarlo entero (la
                            // proxima vuelta recrea el resampler con gen nuevo).
                            if enc_dev_gen.load(Ordering::SeqCst) != gen {
                                continue;
                            }

                            resampled_chunk.clear();
                            resampler.process(&raw_chunk, &mut resampled_chunk);

                            stereo_chunk.clear();
                            if cur_channels == 1 {
                                // Mono to stereo expansion
                                for &s in &resampled_chunk {
                                    stereo_chunk.push(s);
                                    stereo_chunk.push(s);
                                }
                            } else if cur_channels == 2 {
                                stereo_chunk.extend_from_slice(&resampled_chunk);
                            } else {
                                // >2 canales (5.1/7.1 por HDMI, Voicemeeter):
                                // downmix ITU-R BS.775. L = FL + C·0.707 +
                                // envolventes_izq·0.707; R simetrico. LFE fuera.
                                downmix_to_stereo(&resampled_chunk, cur_channels, cur_mask, &mut stereo_chunk);
                            }

                            if let Ok(Some(bytes_written)) = opus.feed_and_encode(&stereo_chunk, &mut encoded_packet) {
                                let frame_data = Arc::new(encoded_packet[..bytes_written].to_vec());
                                let _ = enc_audio_tx.send(frame_data);
                                encoder_metrics.frames_encoded.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    })
                    .expect("Failed to spawn encoder thread");

                // 4. Async Tokio WebSocket Server
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("Failed to build Tokio runtime");

                let addr_str = format!("{}:{}", host, port);
                let socket_addr: std::net::SocketAddr = match addr_str.parse() {
                    Ok(addr) => addr,
                    Err(e) => {
                        eprintln!("Invalid socket address {}: {:?}", addr_str, e);
                        return;
                    }
                };

                let server_metrics = metrics.clone();
                rt.block_on(async move {
                    if let Err(e) = run_websocket_server(socket_addr, audio_tx, server_metrics, shutdown_rx).await {
                        eprintln!("WebSocket server error: {:?}", e);
                    }
                });

                // 5. Cleanup
                wasapi.stop();
                let _ = encoder_thread.join();
            })
            .expect("Failed to spawn main engine thread");

        self.main_thread = Some(handle);

        // Wait for WASAPI initialization result while releasing the GIL
        py.allow_threads(move || {
            let result = match ready_rx.recv() {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(pyo3::exceptions::PyRuntimeError::new_err(e)),
                Err(e) => Err(pyo3::exceptions::PyRuntimeError::new_err(format!("Engine startup channel error: {:?}", e))),
            };
            if result.is_err() {
                // Init fallo: hilo main ya termino. Reset flag + join para
                // no dejar restart muerto ("already running" eterno).
                self.running.store(false, Ordering::SeqCst);
                if let Some(handle) = self.main_thread.take() {
                    let _ = handle.join();
                }
            }
            result
        })
    }

    pub fn stop(&mut self, py: Python<'_>) -> PyResult<()> {
        py.allow_threads(|| {
            if let Some(tx) = self.shutdown_tx.take() {
                let _ = tx.send(true);
            }
            self.running.store(false, Ordering::SeqCst);
            if let Some(handle) = self.main_thread.take() {
                let _ = handle.join();
            }
        });
        Ok(())
    }

    pub fn get_metrics(&self) -> PyResult<PyMetrics> {
        let m = &self.metrics;
        Ok(PyMetrics {
            frames_captured: m.frames_captured.load(Ordering::Relaxed),
            pcm_silent_injected: m.pcm_silent_injected.load(Ordering::Relaxed),
            frames_encoded: m.frames_encoded.load(Ordering::Relaxed),
            bytes_broadcasted: m.bytes_broadcasted.load(Ordering::Relaxed),
            frames_dropped_tcp: m.frames_dropped_tcp.load(Ordering::Relaxed),
            frames_dropped_ring: m.frames_dropped_ring.load(Ordering::Relaxed),
            active_clients: m.active_clients.load(Ordering::Relaxed),
        })
    }

    pub fn get_device_info(&self) -> PyResult<(u32, u32)> {
        Ok((
            self.device_sample_rate.load(Ordering::Relaxed),
            self.device_channels.load(Ordering::Relaxed),
        ))
    }
}

#[pyclass]
#[derive(Debug, Clone)]
pub struct PyMetrics {
    #[pyo3(get)]
    pub frames_captured: u64,
    #[pyo3(get)]
    pub pcm_silent_injected: u64,
    #[pyo3(get)]
    pub frames_encoded: u64,
    #[pyo3(get)]
    pub bytes_broadcasted: u64,
    #[pyo3(get)]
    pub frames_dropped_tcp: u64,
    #[pyo3(get)]
    pub frames_dropped_ring: u64,
    #[pyo3(get)]
    pub active_clients: usize,
}

#[pymodule]
fn pywebrtcsink_core(_py: Python, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyWasapiSinkEngine>()?;
    m.add_class::<PyMetrics>()?;
    Ok(())
}
