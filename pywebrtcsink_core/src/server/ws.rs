use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use crate::metrics::EngineMetrics;
use crate::server::backpressure::{ClientAudioQueue, MAX_PENDING_AUDIO_FRAMES};

pub async fn run_websocket_server(
    addr: SocketAddr,
    audio_tx: broadcast::Sender<Arc<Vec<u8>>>,
    metrics: Arc<EngineMetrics>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    tracing::info!("Audio WebSocket server listening on ws://{}", addr);

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, client_addr)) => {
                        let client_rx = audio_tx.subscribe();
                        let client_metrics = metrics.clone();
                        tokio::spawn(handle_client(stream, client_addr, client_rx, client_metrics));
                    }
                    Err(e) => {
                        tracing::warn!("Accept error: {:?}", e);
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    tracing::info!("WebSocket server shutting down gracefully");
                    break;
                }
            }
        }
    }

    Ok(())
}

async fn handle_client(
    stream: TcpStream,
    addr: SocketAddr,
    mut audio_rx: broadcast::Receiver<Arc<Vec<u8>>>,
    metrics: Arc<EngineMetrics>,
) {
    // Disable Nagle's algorithm for low-latency TCP delivery
    if let Err(e) = stream.set_nodelay(true) {
        tracing::warn!("Failed to set TCP_NODELAY for {}: {:?}", addr, e);
    }

    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            tracing::warn!("WebSocket handshake failed with {}: {:?}", addr, e);
            return;
        }
    };

    metrics.active_clients.fetch_add(1, Ordering::Relaxed);
    tracing::info!("Client connected: {}", addr);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (client_tx, mut client_rx) = mpsc::channel::<Message>(MAX_PENDING_AUDIO_FRAMES);
    let mut queue = ClientAudioQueue::new(client_tx, metrics.clone());

    // Task 1: Write messages to WebSocket sink over TCP
    let writer_task = tokio::spawn(async move {
        while let Some(msg) = client_rx.recv().await {
            if let Err(e) = ws_sender.send(msg).await {
                tracing::debug!("WebSocket write error: {:?}", e);
                break;
            }
        }
    });

    // Task 2: Distribute broadcast frames with drop-tail backpressure
    let distributor_task = tokio::spawn(async move {
        while let Ok(frame) = audio_rx.recv().await {
            queue.try_push_frame(frame);
        }
    });

    // Task 3: Drain inbound messages and keep connection alive
    while let Some(msg_result) = ws_receiver.next().await {
        match msg_result {
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_data)) => {
                // Ping-pong handled automatically by tungstenite
            }
            Err(_) => break,
            _ => {}
        }
    }

    writer_task.abort();
    distributor_task.abort();
    metrics.active_clients.fetch_sub(1, Ordering::Relaxed);
    tracing::info!("Client disconnected: {}", addr);
}
