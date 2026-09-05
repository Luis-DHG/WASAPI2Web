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

mod audio;
mod codec;
mod metrics;
mod server;

#[pyclass]
pub struct PyWasapiSinkEngine {
    running: Arc<AtomicBool>,
    shutdown_tx: Option<watch::Sender<bool>>,
    metrics: Arc<EngineMetrics>,
    main_thread: Option<JoinHandle<()>>,
    device_sample_rate: Arc<std::sync::atomic::AtomicU32>,
    device_channels: Arc<std::sync::atomic::AtomicU32>,
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
            device_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    pub fn start(&mut self, py: Python<'_>, host: String, port: u16, bitrate: i32) -> PyResult<()> {
        if self.running.load(Ordering::SeqCst) {
            return Err(pyo3::exceptions::PyRuntimeError::new_err("Audio engine is already running"));
        }

        self.running.store(true, Ordering::SeqCst);
        let is_running = self.running.clone();
        let metrics = self.metrics.clone();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        self.shutdown_tx = Some(shutdown_tx);

        let dev_rate_atom = self.device_sample_rate.clone();
        let dev_chan_atom = self.device_channels.clone();
        let dev_gen_atom = self.device_generation.clone();

        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

        let handle = std::thread::Builder::new()
            .name("pywebrtcsink-main".to_string())
            .spawn(move || {
                // 1. RingBuffer for raw PCM samples: 1 sec buffer capacity
                let (ring_producer, mut ring_consumer) = rtrb::RingBuffer::new(48000 * 2 * 2);
                let (audio_tx, _) = broadcast::channel::<Arc<Vec<u8>>>(64);

                // 2. Start WASAPI Capture Loopback
                let mut wasapi = match WasapiCaptureLoopback::start(
                    ring_producer,
                    is_running.clone(),
                    metrics.clone(),
                    dev_rate_atom.clone(),
                    dev_chan_atom.clone(),
                    dev_gen_atom.clone(),
                ) {
                    Ok(w) => {
                        dev_rate_atom.store(w.device_info.sample_rate, Ordering::Relaxed);
                        dev_chan_atom.store(w.device_info.channels as u32, Ordering::Relaxed);
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
                        let mut last_gen = enc_dev_gen.load(Ordering::SeqCst);
                        let mut raw_chunk = Vec::with_capacity(1920);
                        let mut resampled_chunk = Vec::with_capacity(1920);
                        let mut stereo_chunk = Vec::with_capacity(1920);
                        let mut encoded_packet = vec![0u8; 1275 + 8]; // Max Opus payload + 8B header

                        while encoder_running.load(Ordering::Relaxed) {
                            // El formato puede cambiar si captura re-enumera
                            // tras device lost: recrear resampler y descartar
                            // resto viejo (seq/ts del Opus se preservan).
                            let gen = enc_dev_gen.load(Ordering::SeqCst);
                            if gen != last_gen {
                                last_gen = gen;
                                let new_rate = enc_dev_rate.load(Ordering::SeqCst).max(1);
                                cur_channels = enc_dev_channels.load(Ordering::SeqCst).max(1) as usize;
                                resampler = LinearResampler::new(new_rate, 48000, cur_channels);
                                opus.discard_pending();
                            }

                            raw_chunk.clear();
                            while let Ok(sample) = ring_consumer.pop() {
                                raw_chunk.push(sample);
                                if raw_chunk.len() >= 960 * cur_channels {
                                    break;
                                }
                            }

                            if raw_chunk.is_empty() {
                                std::thread::sleep(std::time::Duration::from_millis(1));
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
                            } else {
                                stereo_chunk.extend_from_slice(&resampled_chunk);
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

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    pub fn get_metrics(&self) -> PyResult<PyMetrics> {
        let snap = self.metrics.snapshot();
        Ok(PyMetrics {
            frames_captured: snap.frames_captured,
            pcm_silent_injected: snap.pcm_silent_injected,
            frames_encoded: snap.frames_encoded,
            bytes_broadcasted: snap.bytes_broadcasted,
            frames_dropped_tcp: snap.frames_dropped_tcp,
            active_clients: snap.active_clients,
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
    pub active_clients: usize,
}

#[pymodule]
fn pywebrtcsink_core(_py: Python, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyWasapiSinkEngine>()?;
    m.add_class::<PyMetrics>()?;
    Ok(())
}
