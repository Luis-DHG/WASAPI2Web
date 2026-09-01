use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use crate::metrics::EngineMetrics;

pub const MAX_PENDING_AUDIO_FRAMES: usize = 3; // Max 60ms buffer per client

pub struct ClientAudioQueue {
    sender: mpsc::Sender<Message>,
    metrics: Arc<EngineMetrics>,
}

impl ClientAudioQueue {
    pub fn new(sender: mpsc::Sender<Message>, metrics: Arc<EngineMetrics>) -> Self {
        Self { sender, metrics }
    }

    /// Attempts to push a binary frame to the client TCP channel.
    /// If the queue exceeds capacity (60ms), it drops the frame to prevent TCP bufferbloat.
    #[inline]
    pub fn try_push_frame(&mut self, payload: Arc<Vec<u8>>) {
        let msg = Message::Binary((*payload).clone());

        match self.sender.try_send(msg) {
            Ok(_) => {
                self.metrics.bytes_broadcasted.fetch_add(payload.len() as u64, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                // Drop-Tail Backpressure: Network/TCP congested, dropping frame to preserve latency bounds
                self.metrics.frames_dropped_tcp.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                // Client closed socket, handled in main loop
            }
        }
    }
}
