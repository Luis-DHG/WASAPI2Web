"""Servidor HTTP estatico + WebSocket de audio para PyAudioBridge.

Arquitectura:
  * aiohttp.web sirve los archivos de static/ en el puerto 8080.
  * Una ruta /ws acepta conexiones WebSocket clientes.
  * Una tarea async "broadcast pump" lee bloques PCM de una cola provista
    por WasapiLoopbackCapture y los reenvia a todos los WebSocket clientes
    conectados. Implementa backpressure: si una conexion tiene pendientes
    >MAX_QUEUED_BYTES en su propia cola, se descartan bloques para esa
    conexion (o se la desconecta si se satura demasiado tiempo).

Run:
  python src/server.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

from aiohttp import WSMsgType, web, WSMessage

# Import relativo cuando se ejecuta como modulo; absoluto como script.
try:
    from .audio_capture import (
        WasapiLoopbackCapture, AudioFormat, BLOCK_BYTES, SAMPLE_RATE,
        CHANNELS, SAMPLE_WIDTH_BYTES,
    )
    from .utils import get_local_ip, format_size
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from src.audio_capture import (  # type: ignore[no-redef]
        WasapiLoopbackCapture, AudioFormat, BLOCK_BYTES, SAMPLE_RATE,
        CHANNELS, SAMPLE_WIDTH_BYTES,
    )
    from src.utils import get_local_ip, format_size  # type: ignore[no-redef]

log = logging.getLogger("pyaudiobridge.server")

HTTP_PORT = 8080
WS_PATH = "/ws"
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")

# Backpressure
MAX_CLIENT_QUEUE_BYTES = 256 * 1024   # 256 KiB backlog max por cliente
CLIENT_DROP_AFTER_BLOCKS = 50          # si sigue saturado tras N bloques, cerrar
CAPTURE_QUEUE_MAX = 64                 # bloques encolados hacia el pump


# ---------------------------------------------------------------------------
# Cliente WebSocket
# ---------------------------------------------------------------------------

@dataclass(order=True)
class _PendingItem:
    seq: int
    data: bytes = field(compare=False)


class Client:
    """Wrapper de una conexion WebSocket con cola de envio propia."""

    _next_seq = 0

    def __init__(self, ws: web.WebSocketResponse, client_id: int) -> None:
        self.ws = ws
        self.client_id = client_id
        self.queue: "asyncio.Queue[_PendingItem]" = asyncio.Queue(maxsize=64)
        self.queued_bytes = 0
        self.dropped_in_row = 0
        self.connected_at = time.monotonic()
        self.bytes_sent = 0
        self.sender_task: Optional[asyncio.Task] = None

    def schedule(self, data: bytes) -> bool:
        """Encola bloque para envio. Devuelve False si se descarto."""
        if self.queued_bytes + len(data) > MAX_CLIENT_QUEUE_BYTES:
            return False
        Client._next_seq += 1
        item = _PendingItem(Client._next_seq, data)
        if self.queue.full():
            # Descartar el mas viejo para hacer sitio (latencia baja).
            try:
                old = self.queue.get_nowait()
                self.queued_bytes -= len(old.data)
                self.dropped_in_row += 1
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait(item)
        self.queued_bytes += len(data)
        return True

    def clear_backlog(self) -> None:
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self.queued_bytes = 0

    async def sender_loop(self) -> None:
        try:
            while True:
                item = await self.queue.get()
                try:
                    await self.ws.send_bytes(item.data)
                    self.bytes_sent += len(item.data)
                    self.queued_bytes -= len(item.data)
                    if self.queued_bytes < 0:
                        self.queued_bytes = 0
                    self.dropped_in_row = 0
                except (ConnectionResetError, RuntimeError):
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Sender loop fatal (cliente %d)", self.client_id)


# ---------------------------------------------------------------------------
# Servidor
# ---------------------------------------------------------------------------

class AudioBridgeServer:
    def __init__(self, port: int = HTTP_PORT) -> None:
        self.port = port
        self.app = web.Application()
        self.clients: dict[int, Client] = {}
        self._client_counter = 0
        self.capture: Optional[WasapiLoopbackCapture] = None
        self.capture_queue: "asyncio.Queue[bytes]" = asyncio.Queue(
            maxsize=CAPTURE_QUEUE_MAX
        )
        self._pump_task: Optional[asyncio.Task] = None
        self._stats_task: Optional[asyncio.Task] = None
        self._total_broadcast = 0
        self._total_dropped = 0

        self.app.router.add_get("/", self.index_handler)
        self.app.router.add_static("/static", STATIC_DIR, name="static")
        self.app.router.add_get(WS_PATH, self.ws_handler)
        self.app.on_startup.append(self._on_startup)
        self.app.on_cleanup.append(self._on_cleanup)

    # --- lifecycle ---------------------------------------------------------

    async def _on_startup(self, app: web.Application) -> None:
        loop = asyncio.get_running_loop()
        self.capture = WasapiLoopbackCapture(
            loop=loop, queue=self.capture_queue
        )
        self.capture.start()
        log.info("Dispositivo: %s", self.capture.device_name)
        self._pump_task = loop.create_task(self.broadcast_pump(), name="pump")
        self._stats_task = loop.create_task(self.stats_loop(), name="stats")
        log.info("Servidor listo en puerto %d", self.port)

    async def _on_cleanup(self, app: web.Application) -> None:
        if self._pump_task:
            self._pump_task.cancel()
        if self._stats_task:
            self._stats_task.cancel()
        if self.capture:
            self.capture.stop()
        for client in list(self.clients.values()):
            await self._disconnect_client(client.client_id)

    # --- handlers ----------------------------------------------------------

    async def index_handler(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20.0)
        try:
            await ws.prepare(request)
        except Exception:
            raise web.HTTPBadRequest(text="Se requiere WebSocket upgrade")
        self._client_counter += 1
        cid = self._client_counter
        client = Client(ws, cid)
        client.sender_task = asyncio.create_task(client.sender_loop())

        # Enviar cabecera de formato: 4 uint32 little-endian
        # [magic, rate, channels, sample_width]
        cf = self.capture.format if self.capture else AudioFormat()
        header = b"PYAB" + \
                 cf.sample_rate.to_bytes(4, "little") + \
                 cf.channels.to_bytes(4, "little") + \
                 cf.sample_width.to_bytes(4, "little")
        try:
            await ws.send_bytes(header)
        except Exception:
            await ws.close()
            return ws

        self.clients[cid] = client
        peer = request.remote
        log.info("Cliente %d conectado desde %s (total=%d)",
                 cid, peer, len(self.clients))

        try:
            async for msg in ws:
                await self._on_client_msg(cid, client, msg)
        except Exception:
            log.exception("Error en loop de recv (cliente %d)", cid)
        finally:
            await self._disconnect_client(cid)
        return ws

    async def _on_client_msg(self, cid: int, client: Client, msg: WSMessage) -> None:
        if msg.type == WSMsgType.TEXT:
            text = msg.data.strip()
            if text == "ping":
                await client.ws.send_str("pong")
            elif text == "flush":
                client.clear_backlog()
                log.info("Cliente %d pidio flush de backlog", cid)
        elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
            log.info("Cliente %d: cierre/error WS", cid)

    async def _disconnect_client(self, cid: int) -> None:
        client = self.clients.pop(cid, None)
        if not client:
            return
        if client.sender_task:
            client.sender_task.cancel()
            try:
                await client.sender_task
            except (asyncio.CancelledError, Exception):
                pass
        try:
            await client.ws.close()
        except Exception:
            pass
        log.info(
            "Cliente %d desconectado (enviados=%s)",
            cid, format_size(client.bytes_sent),
        )

    # --- broadcast pump ----------------------------------------------------

    async def broadcast_pump(self) -> None:
        """Lee bloques PCM y los reenvia a todos los clientes."""
        log.info("Pump de broadcast iniciado.")
        loop = asyncio.get_running_loop()
        try:
            while True:
                data = await self.capture_queue.get()
                if not self.clients:
                    # Sin clientes: no hacer nada. El bloque se descarta.
                    continue

                # Snapshot de clientes para evitar mutacion durante iteracion.
                snapshot = list(self.clients.values())
                for client in snapshot:
                    ok = client.schedule(data)
                    if not ok:
                        self._total_dropped += 1
                        client.dropped_in_row += 1
                        if client.dropped_in_row > CLIENT_DROP_AFTER_BLOCKS:
                            log.warning(
                                "Cliente %d saturado %d bloques -> desconecta",
                                client.client_id, client.dropped_in_row,
                            )
                            loop.create_task(
                                self._disconnect_client(client.client_id)
                            )
                self._total_broadcast += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Pump fatal")

    async def stats_loop(self) -> None:
        """Log periodico de estado."""
        try:
            while True:
                await asyncio.sleep(15.0)
                qsize = self.capture_queue.qsize()
                log.info(
                    "stats: clientes=%d cola_captura=%d/%d broadcast=%d dropped=%d",
                    len(self.clients), qsize, CAPTURE_QUEUE_MAX,
                    self._total_broadcast, self._total_dropped,
                )
        except asyncio.CancelledError:
            raise

    # --- run ---------------------------------------------------------------

    def run(self) -> None:
        local_ip = get_local_ip()
        log.info("=== PyAudioBridge ===")
        log.info("IP local: %s", local_ip)
        log.info("Abre desde el movil: http://%s:%d", local_ip, self.port)
        log.info("WebSocket:           ws://%s:%d%s", local_ip, self.port, WS_PATH)
        log.info("Directorio estatico: %s", STATIC_DIR)
        web.run_app(
            self.app, host="0.0.0.0", port=self.port,
            access_log=None, print=None,
        )


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def main() -> None:
    configure_logging()
    server = AudioBridgeServer(port=HTTP_PORT)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # Windows: Ctrl-C manejar default para evitar colgar PortAudio.
    try:
        signal.signal(signal.SIGINT, signal.SIG_DFL)
    except Exception:
        pass

    try:
        server.run()
    except KeyboardInterrupt:
        log.info("Cerrando (KeyboardInterrupt).")


if __name__ == "__main__":
    main()
