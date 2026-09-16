use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;
use crate::metrics::EngineMetrics;

/// Cola maxima por cliente: 8 frames = 160 ms. Stall de TCP <= 160 ms no
/// pierde un solo frame (antes: 3 frames / 60 ms -> cualquier hipo de WiFi
/// costaba audio). El coste solo se paga bajo congestion real.
pub const MAX_BACKLOG_FRAMES: usize = 8;

/// Politica de drenaje por cliente. El distributor y el writer son la misma
/// task: el recv del broadcast frene al socket y no al reves. Drop-OLDEST:
/// se descarta el audio mas viejo, no el nuevo (drop-tail pagaba latencia Y
/// continuidad a la vez).
pub struct ClientDrainPolicy {
    rx: broadcast::Receiver<Arc<Vec<u8>>>,
    metrics: Arc<EngineMetrics>,
}

impl ClientDrainPolicy {
    pub fn new(rx: broadcast::Receiver<Arc<Vec<u8>>>, metrics: Arc<EngineMetrics>) -> Self {
        Self { rx, metrics }
    }

    /// Proximo frame para el socket. None = canal cerrado (shutdown).
    /// Lanza los frames mas viejos cuando el backlog supera el cap.
    pub async fn next_frame(&mut self) -> Option<Arc<Vec<u8>>> {
        loop {
            // Resync: si el backlog se paso de largo, descartar viejos hasta
            // quedar en cap. El cliente tapa el hueco con PLC (cap suyo: 3).
            let mut lag = self.rx.len().saturating_sub(MAX_BACKLOG_FRAMES);
            while lag > 0 {
                match self.rx.try_recv() {
                    Ok(_) => {
                        self.metrics.frames_dropped_backlog.fetch_add(1, Ordering::Relaxed);
                        lag -= 1;
                    }
                    Err(_) => break,
                }
            }

            return match self.rx.recv().await {
                Ok(frame) => Some(frame),
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // El broadcast comun (cap 64) tambien reboso: resync contado.
                    self.metrics
                        .frames_dropped_backlog
                        .fetch_add(n, Ordering::Relaxed);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => None,
            };
        }
    }

    /// Empaqueta para el socket. (El Message vive aqui para que la politica
    /// conozca el coste de envio.)
    pub fn pack(frame: &Arc<Vec<u8>>) -> Message {
        Message::Binary((**frame).clone())
    }
}

/// Tests: la policy sin sockets de verdad.
#[cfg(test)]
mod tests {
    use super::*;

    fn frame_of(byte: u8) -> Arc<Vec<u8>> {
        Arc::new(vec![byte; 10])
    }

    #[tokio::test]
    async fn backlog_lleno_descarta_los_mas_viejos() {
        let (tx, _keep) = broadcast::channel::<Arc<Vec<u8>>>(64);
        let metrics = EngineMetrics::new();
        let mut policy = ClientDrainPolicy::new(tx.subscribe(), metrics.clone());

        // Empujar 12 sin consumir: quedan a b c ... l (bytes 1..=12)
        for i in 1..=12u8 {
            tx.send(frame_of(i)).unwrap();
        }

        // next_frame debe drenar: 12 en cola, cap 8 → descarta 1,2,3,4
        let first = policy.next_frame().await.unwrap();
        assert_eq!(first[0], 5, "debe descartar los mas viejos (1..4), no el nuevo");
        assert_eq!(metrics.frames_dropped_backlog.load(Ordering::Relaxed), 4);

        // Y el resto llega en orden.
        for i in 6..=12u8 {
            assert_eq!(policy.next_frame().await.unwrap()[0], i);
        }
    }

    #[tokio::test]
    async fn bajo_cap_no_descarta_nada() {
        let (tx, _keep) = broadcast::channel::<Arc<Vec<u8>>>(64);
        let metrics = EngineMetrics::new();
        let mut policy = ClientDrainPolicy::new(tx.subscribe(), metrics.clone());

        for i in 1..=8u8 {
            tx.send(frame_of(i)).unwrap();
        }
        for i in 1..=8u8 {
            assert_eq!(policy.next_frame().await.unwrap()[0], i);
        }
        assert_eq!(metrics.frames_dropped_backlog.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn cierre_del_canal_propagado() {
        let (tx, _keep) = broadcast::channel::<Arc<Vec<u8>>>(64);
        let mut policy = ClientDrainPolicy::new(tx.subscribe(), EngineMetrics::new());
        drop(tx);
        assert!(policy.next_frame().await.is_none());
    }
}
