use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct EngineMetrics {
    pub frames_captured: AtomicU64,
    pub pcm_silent_injected: AtomicU64,
    pub frames_encoded: AtomicU64,
    pub bytes_broadcasted: AtomicU64,
    pub frames_dropped_tcp: AtomicU64,
    pub active_clients: AtomicUsize,
}

impl EngineMetrics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            frames_captured: self.frames_captured.load(Ordering::Relaxed),
            pcm_silent_injected: self.pcm_silent_injected.load(Ordering::Relaxed),
            frames_encoded: self.frames_encoded.load(Ordering::Relaxed),
            bytes_broadcasted: self.bytes_broadcasted.load(Ordering::Relaxed),
            frames_dropped_tcp: self.frames_dropped_tcp.load(Ordering::Relaxed),
            active_clients: self.active_clients.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MetricsSnapshot {
    pub frames_captured: u64,
    pub pcm_silent_injected: u64,
    pub frames_encoded: u64,
    pub bytes_broadcasted: u64,
    pub frames_dropped_tcp: u64,
    pub active_clients: usize,
}
