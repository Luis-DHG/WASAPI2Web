"""Servidor HTTP estatico + WebSocket de audio para PyAudioBridge.

Arquitectura:
  * aiohttp.web sirve archivos estaticos y el index.
  * /ws acepta conexiones WebSocket. Cada cliente negocia mono/skip via
    query string (?mono=1&skip=1). Rate fijo al nativo del dispositivo
    (tipicamente 48 kHz). Solo codec PCM Int16 LE.
  * Una tarea async "capture pump" lee bloques PCM crudos de la cola y los
    reparte a un unico BlockProcessor (formato nativo + mono opcional).
  * Cada ProcessedBlock se reenvia con cabecera de 8B (uint32 ts_ms + flags).
  * Backpressure: si la cola de un cliente se satura, se descartan bloques.
  * WS heartbeat 15s server-side para mantener NAT vivo + detectar peers
    caidos en background/pantalla apagada (critico para Android Doze).

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
from dataclasses import dataclass
from typing import Optional

from aiohttp import WSMsgType, web, WSMessage

# Import relativo cuando se ejecuta como modulo; absoluto como script.
try:
    from .audio_capture import (
        WasapiLoopbackCapture, AudioFormat, BlockProcessor, ProcessedBlock,
        BLOCK_HEADER_BYTES, CODEC_PCM, SAMPLE_WIDTH_BYTES,
        FRAMES_PER_BLOCK,
    )
    from .utils import get_local_ip, format_size
    from .errors import WSUpgradeError, CaptureError
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from src.audio_capture import (  # type: ignore[no-redef]
        WasapiLoopbackCapture, AudioFormat, BlockProcessor, ProcessedBlock,
        BLOCK_HEADER_BYTES, CODEC_PCM, SAMPLE_WIDTH_BYTES,
        FRAMES_PER_BLOCK,
    )
    from src.utils import get_local_ip, format_size  # type: ignore[no-redef]
    from src.errors import WSUpgradeError, CaptureError  # type: ignore[no-redef]

log = logging.getLogger("pyaudiobridge.server")

HTTP_PORT = 8080
WS_PATH = "/ws"
STATIC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
)

# Backpressure
MAX_CLIENT_QUEUE_BYTES = 256 * 1024
CLIENT_DROP_AFTER_BLOCKS = 50
CAPTURE_QUEUE_MAX = 64

# WS keepalive server-side (WS-level PING frames).
WS_HEARTBEAT_S = 15.0


# ---------------------------------------------------------------------------
# Cliente WebSocket
# ---------------------------------------------------------------------------

class Client:
    """Wrapper de una conexion WebSocket con cola de envio FIFO propia."""

    def __init__(self, ws: web.WebSocketResponse, client_id: int,
                 fmt: AudioFormat) -> None:
        self.ws = ws
        self.client_id = client_id
        self.fmt = fmt
        self.queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=64)
        self.queued_bytes = 0
        self.dropped_in_row = 0
        self.connected_at = time.monotonic()
        self.bytes_sent = 0
        self.sender_task: Optional[asyncio.Task] = None

    def schedule(self, data: bytes) -> bool:
        if self.queued_bytes + len(data) > MAX_CLIENT_QUEUE_BYTES:
            return False
        if self.queue.full():
            try:
                old = self.queue.get_nowait()
                self.queued_bytes -= len(old)
                self.dropped_in_row += 1
            except asyncio.QueueEmpty:
                pass
        try:
            self.queue.put_nowait(data)
        except asyncio.QueueFull:
            return False
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
                    await self.ws.send_bytes(item)
                    self.bytes_sent += len(item)
                    self.queued_bytes -= len(item)
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
# Formato: parser de query string
# ---------------------------------------------------------------------------

def parse_client_format(query: str, device_rate: int,
                        device_channels: int) -> AudioFormat:
    """Parsea y valida los parametros del cliente.

    Solo soporta: mono (0/1), skip (0/1), rate (0 = nativo).
    Codec siempre PCM. Sin downsample (rate se ignora si != nativo, con warning).
    """
    from urllib.parse import parse_qs

    q = parse_qs(query)

    def first(key: str, default: str) -> str:
        v = q.get(key)
        return v[0] if v else default

    # Rate: 0 = nativo. Solo se acepta el nativo (WASAPI shared mode).
    try:
        rate = int(first("rate", "0"))
    except ValueError:
        rate = 0
    if rate == 0:
        rate = device_rate
    elif rate != device_rate:
        log.warning("Rate %d != nativo %d. Forzando nativo (sin downsample).",
                    rate, device_rate)
        rate = device_rate

    # Channels
    mono_str = first("mono", "0").lower()
    if mono_str not in ("0", "1", "true", "false", "yes", "no"):
        log.warning("mono=%r invalido, fallback stereo", mono_str)
        mono = False
    else:
        mono = mono_str in ("1", "true", "yes")
    channels = 1 if mono else min(2, device_channels)

    return AudioFormat(
        sample_rate=rate,
        channels=channels,
        sample_width=SAMPLE_WIDTH_BYTES,
        codec=CODEC_PCM,
        frames_per_block=FRAMES_PER_BLOCK,
    )


def parse_skip_flag(query: str) -> bool:
    """Lee el flag skip=0/1 de la query string."""
    from urllib.parse import parse_qs
    v = parse_qs(query).get("skip")
    if not v:
        return True
    return v[0] in ("1", "true", "yes")


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
        self.capture_queue: "asyncio.Queue[tuple[int, int, bytes]]" = \
            asyncio.Queue(maxsize=CAPTURE_QUEUE_MAX)

        # Un unico procesador (formato nativo, mono/stereo por cliente).
        # Mantenemos un processor por (channels) para soportar mono/stereo.
        self.processors: dict[tuple, BlockProcessor] = {}

        self._pump_task: Optional[asyncio.Task] = None
        self._stats_task: Optional[asyncio.Task] = None
        self._started_at: float = 0.0

        self.app.router.add_get("/", self.index_handler)
        self.app.router.add_static("/static", STATIC_DIR, name="static")
        self.app.router.add_get(WS_PATH, self.ws_handler)
        self.app.on_startup.append(self._on_startup)
        self.app.on_cleanup.append(self._on_cleanup)

    # --- lifecycle ---------------------------------------------------------

    async def _on_startup(self, app: web.Application) -> None:
        loop = asyncio.get_running_loop()
        self.capture = WasapiLoopbackCapture(
            loop=loop, raw_queue=self.capture_queue
        )
        self.capture.start()
        log.info("Dispositivo: %s (rate=%d ch=%d)",
                 self.capture.device_name,
                 self.capture.device_rate,
                 self.capture.device_channels)
        self._pump_task = loop.create_task(self.broadcast_pump(), name="pump")
        self._stats_task = loop.create_task(self.stats_loop(), name="stats")
        self._started_at = time.monotonic()
        log.info("Servidor listo en puerto %d", self.port)

    async def _on_cleanup(self, app: web.Application) -> None:
        for t in (self._pump_task, self._stats_task):
            if t:
                t.cancel()
        if self.capture:
            self.capture.stop()
        for client in list(self.clients.values()):
            await self._disconnect_client(client.client_id)

    # --- handlers HTTP -----------------------------------------------------

    async def index_handler(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))

    # --- handlers WS -------------------------------------------------------

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        # heartbeat server-side: WS-level PING frames cada 15s (TCP keepalive).
        ws = web.WebSocketResponse(heartbeat=WS_HEARTBEAT_S)
        try:
            await ws.prepare(request)
        except Exception:
            raise WSUpgradeError()

        query = request.query_string
        self._client_counter += 1
        cid = self._client_counter

        # Negociar formato (rate=nativo, codec=pcm, mono/skip via query).
        dev = self.capture
        dev_rate = dev.device_rate if dev else 48000
        dev_ch = dev.device_channels if dev else 2
        fmt = parse_client_format(query, dev_rate, dev_ch)
        skip = parse_skip_flag(query)

        # Ajustar skip en el processor ese cliente (se crea bajo demanda).
        client = Client(ws, cid, fmt)
        client.sender_task = asyncio.create_task(client.sender_loop())
        client.skip_silence = skip  # type: ignore[attr-defined]

        # Cabecera handshake: "PYAB" + uint32 rate + uint32 channels +
        # uint32 sample_width + uint32 codec + uint32 block_header_bytes.
        header = (
            b"PYAB"
            + fmt.sample_rate.to_bytes(4, "little")
            + fmt.channels.to_bytes(4, "little")
            + fmt.sample_width.to_bytes(4, "little")
            + fmt.codec.to_bytes(4, "little")
            + BLOCK_HEADER_BYTES.to_bytes(4, "little")
        )
        try:
            await ws.send_bytes(header)
        except Exception:
            await ws.close()
            return ws

        self.clients[cid] = client
        peer = request.remote
        log.info(
            "Cliente %d conectado desde %s | rate=%d ch=%d codec=pcm skip=%d (total=%d)",
            cid, peer, fmt.sample_rate, fmt.channels, skip,
            len(self.clients),
        )

        # Enviar nombre del dispositivo.
        try:
            if dev:
                await ws.send_str("device:" + dev.device_name)
        except Exception:
            pass

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
            text = msg.data.strip() if isinstance(msg.data, str) else ""
            if text == "ping":
                try:
                    await client.ws.send_str("pong")
                except Exception:
                    pass
            elif text == "flush":
                client.clear_backlog()
                log.info("Cliente %d pidio flush de backlog", cid)
            elif text == "bye":
                log.info("Cliente %d envio bye", cid)
            elif text == "resync":
                # Reenviar cabecera.
                fmt = client.fmt
                header = (
                    b"PYAB"
                    + fmt.sample_rate.to_bytes(4, "little")
                    + fmt.channels.to_bytes(4, "little")
                    + fmt.sample_width.to_bytes(4, "little")
                    + fmt.codec.to_bytes(4, "little")
                    + BLOCK_HEADER_BYTES.to_bytes(4, "little")
                )
                try:
                    await client.ws.send_bytes(header)
                except Exception:
                    pass
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

    # --- procesadores por formato -----------------------------------------

    def _fmt_key(self, fmt: AudioFormat) -> tuple:
        return (fmt.sample_rate, fmt.channels, fmt.codec)

    def _get_or_create_processor(self, fmt: AudioFormat,
                                 skip_silence: bool) -> BlockProcessor:
        # Clave incluye skip para distinguir clientes con/sin skip.
        key = self._fmt_key(fmt) + (skip_silence,)
        p = self.processors.get(key)
        if p is None:
            p = BlockProcessor(
                fmt=fmt,
                device_rate=self.capture.device_rate if self.capture else 48000,
                device_channels=self.capture.device_channels if self.capture else 2,
                skip_silence=skip_silence,
            )
            self.processors[key] = p
            log.info("Nuevo BlockProcessor: rate=%d ch=%d skip=%d",
                     fmt.sample_rate, fmt.channels, skip_silence)
        return p

    # --- broadcast pump ----------------------------------------------------

    async def broadcast_pump(self) -> None:
        """Lee bloques crudos, los procesa y los reenvia."""
        log.info("Pump de broadcast iniciado.")
        loop = asyncio.get_running_loop()
        try:
            while True:
                seq, ts_ms, pcm = await self.capture_queue.get()

                if not self.clients:
                    continue

                processed_cache: dict[tuple, ProcessedBlock] = {}
                snapshot = list(self.clients.values())
                for client in snapshot:
                    key = self._fmt_key(client.fmt) + (client.skip_silence,)  # type: ignore[attr-defined]
                    pblock = processed_cache.get(key)
                    if pblock is None:
                        p = self._get_or_create_processor(client.fmt,
                                                          client.skip_silence)  # type: ignore[attr-defined]
                        pblock = p.process(seq, ts_ms, pcm)
                        processed_cache[key] = pblock

                    if pblock is None:
                        continue
                    if pblock.payload and len(pblock.payload) > 0:
                        block_data = (
                            pblock.ts_ms.to_bytes(4, "little")
                            + (0).to_bytes(4, "little")
                            + pblock.payload
                        )
                        ok = client.schedule(block_data)
                        if not ok:
                            client.dropped_in_row += 1
                            if client.dropped_in_row > CLIENT_DROP_AFTER_BLOCKS:
                                log.warning(
                                    "Cliente %d saturado %d -> desconecta",
                                    client.client_id, client.dropped_in_row,
                                )
                                loop.create_task(
                                    self._disconnect_client(client.client_id)
                                )
                    elif pblock.is_silence:
                        # Bloque de silencio: enviar solo cabecera (payload 0)
                        # para que el cliente realinee su scheduler.
                        block_data = (
                            pblock.ts_ms.to_bytes(4, "little")
                            + (1).to_bytes(4, "little")  # flag silence
                        )
                        client.schedule(block_data)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Pump fatal")

    async def stats_loop(self) -> None:
        """Log periodico de estado (cada 15s)."""
        try:
            while True:
                await asyncio.sleep(15.0)
                qsize = self.capture_queue.qsize()
                log.info(
                    "stats: clientes=%d proc=%d cola=%d/%d",
                    len(self.clients), len(self.processors),
                    qsize, CAPTURE_QUEUE_MAX,
                )
        except asyncio.CancelledError:
            raise

    # --- run ---------------------------------------------------------------

    def run(self) -> None:
        local_ip = get_local_ip()
        log.info("=== PyAudioBridge ===")
        log.info("IP local: %s", local_ip)
        log.info("Movil:    http://%s:%d", local_ip, self.port)
        log.info("WS URL:    ws://%s:%d%s", local_ip, self.port, WS_PATH)
        log.info("Static:   %s", STATIC_DIR)
        try:
            web.run_app(
                self.app, host="0.0.0.0", port=self.port,
                access_log=None, shutdown_timeout=5.0, handle_signals=True,
            )
        except TypeError:
            web.run_app(
                self.app, host="0.0.0.0", port=self.port,
                shutdown_timeout=5,
            )


def configure_logging() -> None:
    """Configura logging estructurado en formato JSON lines."""
    import json
    from datetime import datetime, timezone

    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            payload: dict[str, object] = {
                "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "level": record.levelname,
                "logger": record.name,
                "msg": record.getMessage(),
            }
            if record.exc_info and record.exc_info[1] is not None:
                payload["exc"] = self.formatException(record.exc_info)
            return json.dumps(payload, ensure_ascii=False)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def main() -> None:
    configure_logging()
    server = AudioBridgeServer(port=HTTP_PORT)

    # Windows: SIGINT -> KeyboardInterrupt. CTRL_BREAK_EVENT maneja PortAudio.
    try:
        signal.signal(signal.SIGINT, signal.SIG_DFL)
    except Exception:
        pass

    try:
        server.run()
    except KeyboardInterrupt:
        log.info("Cerrando (KeyboardInterrupt) - graceful shutdown iniciado.")
    except Exception as exc:
        log.exception("Cierre inesperado: %s", exc)
    finally:
        log.info("Servidor detenido.")


if __name__ == "__main__":
    main()
