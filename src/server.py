"""Servidor HTTP estatico + WebSocket de audio para PyAudioBridge.

Arquitectura:
  * aiohttp.web sirve archivos estaticos y el index.
  * /ws acepta conexiones WebSocket. Cada cliente negocia su formato via
    query string (?mono=1&rate=24000&codec=mulaw&latency=200&skip=1).
  * Una tarea async "capture pump" lee bloques PCM crudos de la cola y los
    reparte a procesos BlockProcessor (uno por formato unico en uso).
  * Cada ProcessedBlock se reenvia a los clientes de ese formato con una
    cabecera de bloque (timestamp + flags).
  * Backpressure: si la cola de un cliente se satura, se descartan bloques.

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
        WasapiLoopbackCapture, AudioFormat, BlockProcessor, ProcessedBlock,
        BLOCK_HEADER_BYTES, CODEC_PCM, CODEC_MULAW, SAMPLE_WIDTH_BYTES,
        FRAMES_PER_BLOCK,
    )
    from .utils import get_local_ip, format_size
    from .errors import WSUpgradeError, CaptureError
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from src.audio_capture import (  # type: ignore[no-redef]
        WasapiLoopbackCapture, AudioFormat, BlockProcessor, ProcessedBlock,
        BLOCK_HEADER_BYTES, CODEC_PCM, CODEC_MULAW, SAMPLE_WIDTH_BYTES,
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

# Rates permitidos (whitelist) - proteccion basica.
ALLOWED_RATES = {16000, 22050, 24000, 32000, 44100, 48000}

# Broadcast de nivel RMS cada N ms.
LEVEL_BROADCAST_MS = 500


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

    def __init__(self, ws: web.WebSocketResponse, client_id: int,
                 fmt: AudioFormat) -> None:
        self.ws = ws
        self.client_id = client_id
        self.fmt = fmt
        self.queue: "asyncio.Queue[_PendingItem]" = asyncio.Queue(maxsize=64)
        self.queued_bytes = 0
        self.dropped_in_row = 0
        self.connected_at = time.monotonic()
        self.bytes_sent = 0
        self.sender_task: Optional[asyncio.Task] = None
        # Metricas cliente -> servidor (opcional, incoming).
        self.last_stats = {}

    def schedule(self, data: bytes) -> bool:
        if self.queued_bytes + len(data) > MAX_CLIENT_QUEUE_BYTES:
            return False
        Client._next_seq += 1
        item = _PendingItem(Client._next_seq, data)
        if self.queue.full():
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
# Formato: parser de query string
# ---------------------------------------------------------------------------

def parse_client_format(query: str, device_rate: int,
                        device_channels: int) -> AudioFormat:
    """Parsea y valida los parametros del cliente.
    Valores fuera de rango se clampean a defaults del dispositivo.
    """
    from urllib.parse import parse_qs

    q = parse_qs(query)

    def first(key: str, default: str) -> str:
        v = q.get(key)
        return v[0] if v else default

    # Rate — clamping a allowlist.
    try:
        rate = int(first("rate", str(device_rate)))
    except ValueError:
        rate = device_rate
    if rate not in ALLOWED_RATES:
        log.warning("Rate %d fuera de allowlist, fallback %d", rate, device_rate)
        rate = device_rate

    # Channels
    mono_str = first("mono", "0").lower()
    if mono_str not in ("0", "1", "true", "false", "yes", "no"):
        log.warning("mono=%r invalido, fallback stereo", mono_str)
        mono = False
    else:
        mono = mono_str in ("1", "true", "yes")
    channels = 1 if mono else min(2, device_channels)

    # Codec
    codec_str = first("codec", "pcm").lower()
    valid_codecs = ("pcm", "mulaw", "mu-law", "u-law", "g711")
    if codec_str not in valid_codecs:
        log.warning("codec=%r invalido, fallback pcm", codec_str)
        codec_str = "pcm"
    codec = CODEC_MULAW if codec_str in ("mulaw", "mu-law", "u-law", "g711") \
        else CODEC_PCM

    return AudioFormat(
        sample_rate=rate,
        channels=channels,
        sample_width=SAMPLE_WIDTH_BYTES,
        codec=codec,
        frames_per_block=FRAMES_PER_BLOCK,
    )


def parse_bool(query: str, key: str, default: bool = False) -> bool:
    from urllib.parse import parse_qs
    v = parse_qs(query).get(key)
    if not v:
        return default
    return v[0] in ("1", "true", "yes")


def parse_int(query: str, key: str, default: int) -> int:
    from urllib.parse import parse_qs
    v = parse_qs(query).get(key)
    if not v:
        return default
    try:
        return int(v[0])
    except ValueError:
        return default


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

        # Procesadores por formato (key = AudioFormat serializado).
        self.processors: dict[tuple, BlockProcessor] = {}
        # Mapeo cliente -> formato key (para saber a que procesador aplicar).
        # Esto se decide en runtime: cada cliente recibe el mismo bloque pero
        # transformado por su processor.

        self._pump_task: Optional[asyncio.Task] = None
        self._stats_task: Optional[asyncio.Task] = None
        self._level_task: Optional[asyncio.Task] = None
        self._total_broadcast = 0
        self._total_dropped = 0
        self._last_level_rms = 0.0
        self._last_level_ts = 0.0
        self._started_at: float = 0.0

        self.app.router.add_get("/", self.index_handler)
        self.app.router.add_get("/health", self.health_handler)
        self.app.router.add_get("/metrics", self.metrics_handler)
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
        self._level_task = loop.create_task(self.level_loop(), name="level")
        self._started_at = time.monotonic()
        log.info("Servidor listo en puerto %d", self.port)

    async def _on_cleanup(self, app: web.Application) -> None:
        for t in (self._pump_task, self._stats_task, self._level_task):
            if t:
                t.cancel()
        if self.capture:
            self.capture.stop()
        for client in list(self.clients.values()):
            await self._disconnect_client(client.client_id)

    # --- handlers HTTP -----------------------------------------------------

    async def index_handler(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))

    async def health_handler(self, request: web.Request) -> web.Response:
        """GET /health — estado compacto JSON."""
        uptime = (time.monotonic() - self._started_at) if self._started_at else 0.0
        capture_ok = self.capture is not None and self.capture.is_running()
        payload = {
            "status": "ok" if capture_ok else "degraded",
            "uptime_s": round(uptime, 1),
            "clients": len(self.clients),
            "capture": {
                "running": capture_ok,
                "device": self.capture.device_name if self.capture else None,
                "rate": self.capture.device_rate if self.capture else 0,
                "channels": self.capture.device_channels if self.capture else 0,
            },
            "broadcast_total": self._total_broadcast,
            "dropped_total": self._total_dropped,
            "capture_qsize": self.capture_queue.qsize(),
        }
        status_code = 200 if capture_ok else 503
        return web.json_response(payload, status=status_code)

    async def metrics_handler(self, request: web.Request) -> web.Response:
        """Endpoint Prometheus-style text/plain."""
        lines = [
            f"# HELP pab_clients Clientes conectados",
            f"# TYPE pab_clients gauge",
            f"pab_clients {len(self.clients)}",
            f"# HELP pab_broadcast_total Bloques broadcasteados",
            f"# TYPE pab_broadcast_total counter",
            f"pab_broadcast_total {self._total_broadcast}",
            f"# HELP pab_dropped_total Bloques descartados",
            f"# TYPE pab_dropped_total counter",
            f"pab_dropped_total {self._total_dropped}",
            f"# HELP pab_capture_qsize Cola de captura",
            f"# TYPE pab_capture_qsize gauge",
            f"pab_capture_qsize {self.capture_queue.qsize()}",
            f"# HELP pab_last_level Nivel RMS ultimo",
            f"# TYPE pab_last_level gauge",
            f"pab_last_level {self._last_level_rms:.4f}",
        ]
        return web.Response(
            text="\n".join(lines) + "\n",
            content_type="text/plain; version=0.0.4"
        )

    # --- handlers WS -------------------------------------------------------

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=None)
        try:
            await ws.prepare(request)
        except Exception:
            raise WSUpgradeError()

        query = request.query_string
        self._client_counter += 1
        cid = self._client_counter

        # Negociar formato.
        dev = self.capture
        dev_rate = dev.device_rate if dev else 48000
        dev_ch = dev.device_channels if dev else 2
        fmt = parse_client_format(query, dev_rate, dev_ch)

        client = Client(ws, cid, fmt)
        client.sender_task = asyncio.create_task(client.sender_loop())

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
            "Cliente %d conectado desde %s | rate=%d ch=%d codec=%s (total=%d)",
            cid, peer, fmt.sample_rate, fmt.channels,
            "mulaw" if fmt.codec == CODEC_MULAW else "pcm",
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
            text = msg.data.strip()
            if text == "ping":
                await client.ws.send_str("pong")
            elif text == "flush":
                client.clear_backlog()
                log.info("Cliente %d pidio flush de backlog", cid)
            elif text.startswith("{") and "type" in text:
                # Mensaje JSON de telemetria cliente -> servidor.
                self._handle_client_stats(cid, text)
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

    def _handle_client_stats(self, cid: int, text: str) -> None:
        import json
        try:
            data = json.loads(text)
        except Exception:
            return
        if data.get("type") == "stats":
            client = self.clients.get(cid)
            if client:
                client.last_stats = {
                    "latency_ms": data.get("latency_ms"),
                    "underruns": data.get("underruns"),
                    "rtt_ms": data.get("rtt_ms"),
                }
                log.debug("Cliente %d stats: %s", cid, client.last_stats)

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
        # Limpiar procesadores no usados.
        self._gc_processors()
        log.info(
            "Cliente %d desconectado (enviados=%s, stats=%s)",
            cid, format_size(client.bytes_sent), client.last_stats or {},
        )

    # --- procesadores por formato -----------------------------------------

    def _fmt_key(self, fmt: AudioFormat) -> tuple:
        return (fmt.sample_rate, fmt.channels, fmt.codec)

    def _get_or_create_processor(self, fmt: AudioFormat) -> BlockProcessor:
        key = self._fmt_key(fmt)
        p = self.processors.get(key)
        if p is None:
            p = BlockProcessor(
                fmt=fmt,
                device_rate=self.capture.device_rate if self.capture else 48000,
                device_channels=self.capture.device_channels if self.capture else 2,
            )
            self.processors[key] = p
            log.info("Nuevo BlockProcessor: rate=%d ch=%d codec=%s",
                     fmt.sample_rate, fmt.channels,
                     "mulaw" if fmt.codec == CODEC_MULAW else "pcm")
        return p

    def _gc_processors(self) -> None:
        """Elimina procesadores sin clientes."""
        if not self.clients:
            # Si no hay clientes, mantener solo el mas comun? mejor vaciar.
            if self.processors:
                self.processors.clear()
                log.info("Procesadores limpiados (sin clientes).")
            return
        # Formatos en uso.
        in_use = {self._fmt_key(c.fmt) for c in self.clients.values()}
        for k in list(self.processors.keys()):
            if k not in in_use:
                self.processors.pop(k, None)
                log.info("Procesador elimidado: %s", k)

    # --- broadcast pump ----------------------------------------------------

    async def broadcast_pump(self) -> None:
        """Lee bloques crudos, los procesa por formato y los reenvia."""
        log.info("Pump de broadcast iniciado.")
        loop = asyncio.get_running_loop()
        try:
            while True:
                seq, ts_ms, pcm = await self.capture_queue.get()

                if not self.clients:
                    continue

                # Procesar por formato unico (cacheado por processor).
                processed_cache: dict[tuple, ProcessedBlock] = {}
                snapshot = list(self.clients.values())
                for client in snapshot:
                    key = self._fmt_key(client.fmt)
                    pblock = processed_cache.get(key)
                    if pblock is None:
                        p = self._get_or_create_processor(client.fmt)
                        pblock = p.process(seq, ts_ms, pcm)
                        processed_cache[key] = pblock

                    # Actualizar nivel global (ultimas muestras validas).
                    if pblock and not pblock.is_silence:
                        self._last_level_rms = pblock.rms
                        self._last_level_ts = time.monotonic()

                    if pblock is None:
                        # Descartado por silencio: skip client.
                        continue
                    if pblock.payload and len(pblock.payload) > 0:
                        # Envolver con cabecera de bloque:
                        # uint32 ts_ms  + uint32 flags(reservado) + payload.
                        block_data = (
                            pblock.ts_ms.to_bytes(4, "little")
                            + (0).to_bytes(4, "little")
                            + pblock.payload
                        )
                        ok = client.schedule(block_data)
                        if not ok:
                            self._total_dropped += 1
                            client.dropped_in_row += 1
                            if (
                                client.dropped_in_row
                                > CLIENT_DROP_AFTER_BLOCKS
                            ):
                                log.warning(
                                    "Cliente %d saturado %d -> desconecta",
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

    async def level_loop(self) -> None:
        """Envia nivel RMS a todos los clientes cada LEVEL_BROADCAST_MS."""
        log.info("Loop de nivel iniciado (%d ms).", LEVEL_BROADCAST_MS)
        try:
            while True:
                await asyncio.sleep(LEVEL_BROADCAST_MS / 1000.0)
                if not self.clients:
                    continue
                msg = "level:" + f"{self._last_level_rms:.3f}"
                snapshot = list(self.clients.values())
                for client in snapshot:
                    try:
                        await client.ws.send_str(msg)
                    except Exception:
                        pass
        except asyncio.CancelledError:
            raise

    async def stats_loop(self) -> None:
        """Log periodico de estado."""
        try:
            while True:
                await asyncio.sleep(15.0)
                qsize = self.capture_queue.qsize()
                log.info(
                    "stats: clientes=%d proc=%d cola=%d/%d bcast=%d drop=%d nivel=%.3f",
                    len(self.clients), len(self.processors),
                    qsize, CAPTURE_QUEUE_MAX,
                    self._total_broadcast, self._total_dropped,
                    self._last_level_rms,
                )
        except asyncio.CancelledError:
            raise

    # --- run ---------------------------------------------------------------

    def run(self) -> None:
        local_ip = get_local_ip()
        log.info("=== PyAudioBridge ===")
        log.info("IP local: %s", local_ip)
        log.info("Movil:    http://%s:%d", local_ip, self.port)
        log.info("Health:   http://%s:%d/health", local_ip, self.port)
        log.info("Metrics:  http://%s:%d/metrics", local_ip, self.port)
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
        log.info("Cerrando (KeyboardInterrupt) — graceful shutdown iniciado.")
    except Exception as exc:
        log.exception("Cierre inesperado: %s", exc)
    finally:
        log.info("Servidor detenido.")


if __name__ == "__main__":
    main()
