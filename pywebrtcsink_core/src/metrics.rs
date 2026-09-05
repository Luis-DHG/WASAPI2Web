use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::Arc;

#[derive(Default)]
pub struct EngineMetrics {
    pub frames_captured: AtomicU64,
    pub pcm_silent_injected: AtomicU64,
    pub frames_encoded: AtomicU64,
    pub bytes_broadcasted: AtomicU64,
    pub frames_dropped_tcp: AtomicU64,
    pub frames_dropped_ring: AtomicU64,
    pub active_clients: AtomicUsize,
}

impl EngineMetrics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}
