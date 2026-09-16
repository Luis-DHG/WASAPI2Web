use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::accept_async;

use crate::metrics::EngineMetrics;
use crate::server::backpressure::ClientDrainPolicy;

pub async fn run_websocket_server(
    addr: SocketAddr,
    audio_tx: broadcast::Sender<Arc<Vec<u8>>>,
    metrics: Arc<EngineMetrics>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    eprintln!("[ws] escuchando en ws://{}", addr);

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
                        eprintln!("[ws] accept error: {:?}", e);
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    eprintln!("[ws] cerrando server");
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
        eprintln!("[ws] TCP_NODELAY falló para {}: {:?}", addr, e);
    }

    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[ws] handshake falló con {}: {:?}", addr, e);
            return;
        }
    };

    let active = metrics.active_clients.fetch_add(1, Ordering::Relaxed) + 1;
    eprintln!("[ws] cliente CONECTADO: {} (activos: {})", addr, active);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Un solo writer que consume el broadcast directamente: la lentitud del
    // socket frena el recv, y la policy descarta los frames MAS VIEJOS cuando
    // el backlog supera el cap (drop-oldest, no drop-tail).
    let writer_metrics = metrics.clone();
    let mut policy = ClientDrainPolicy::new(audio_rx, writer_metrics.clone());
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = policy.next_frame().await {
            if let Err(e) = ws_sender.send(ClientDrainPolicy::pack(&frame)).await {
                eprintln!("[ws] write error: {:?}", e);
                break;
            }
            writer_metrics.bytes_broadcasted.fetch_add(frame.len() as u64, Ordering::Relaxed);
        }
    });

    // Drain inbound messages and keep connection alive
    while let Some(msg_result) = ws_receiver.next().await {
        match msg_result {
            Ok(msg) if msg.is_close() => break,
            Err(_) => break,
            // ponytail: pings/pongs los responde tungstenite solo
            _ => {}
        }
    }

    writer_task.abort();
    let remaining = metrics.active_clients.fetch_sub(1, Ordering::Relaxed) - 1;
    eprintln!("[ws] cliente DESCONECTADO: {} (activos: {})", addr, remaining);
}
