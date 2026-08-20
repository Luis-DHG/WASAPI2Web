"""Servidor HTTP + senalizacion WebRTC para PyWebRTCSink.

Arquitectura:
  * aiohttp.web sirve archivos estaticos y el index.
  * POST /offer recibe SDP Offer del cliente (JSON {sdp, type}),
    crea RTCPeerConnection, suscribe una cola al CaptureBus, anade CustomAudioTrack,
    genera SDP Answer y lo devuelve como JSON. Stateless: no guarda sesiones en DB/cookie.
  * La captura WASAPI corre en hebra propia y publica bloques PCM en
    un CaptureBus con fan-out a cada CustomAudioTrack activo.
  * RTCPeerConnection se limpia sola cuando connectionState -> failed/closed.

Run:
  python src/server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

from aiohttp import web

# Import relativo cuando se ejecuta como modulo; absoluto como script.
try:
    from .audio_capture import WasapiLoopbackCapture
    from .audio_track import CustomAudioTrack
    from .capture_bus import CaptureBus
    from .utils import get_local_ip
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from src.audio_capture import WasapiLoopbackCapture  # type: ignore
    from src.audio_track import CustomAudioTrack  # type: ignore
    from src.capture_bus import CaptureBus  # type: ignore
    from src.utils import get_local_ip  # type: ignore

from aiortc import RTCPeerConnection, RTCSessionDescription

log = logging.getLogger("pywertcsink.server")

HTTP_PORT = 8080
STATIC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
)
CAPTURE_QUEUE_MAX = 64
PC_DISCONNECT_TIMEOUT = 5.0   # seg sin recovery antes de purgar


class WebRTCServer:
    def __init__(self, port: int = HTTP_PORT) -> None:
        self.port = port
        self.app = web.Application()
        self.capture: WasapiLoopbackCapture | None = None
        self.bus = CaptureBus(maxsize=CAPTURE_QUEUE_MAX)
        # ponytail: mapa pc -> peer_queue para permitir unsubscribe limpio e idempotente.
        self._peer_queues: dict[RTCPeerConnection, asyncio.Queue[bytes]] = {}

        self.app.router.add_get("/", self.index_handler)
        self.app.router.add_post("/offer", self.offer_handler)
        self.app.router.add_post("/api/pc/media-key", self.media_key_handler)
        self.app.router.add_static("/static", STATIC_DIR, name="static")
        self.app.on_startup.append(self._on_startup)
        self.app.on_cleanup.append(self._on_cleanup)

    # --- lifecycle ---------------------------------------------------------

    async def _on_startup(self, app: web.Application) -> None:
        loop = asyncio.get_running_loop()
        self.capture = WasapiLoopbackCapture(
            loop=loop, bus=self.bus
        )
        self.capture.start()
        log.info(
            "Listo — http://%s:%d — %s (%dHz %dch)",
            get_local_ip(), self.port,
            self.capture.device_name,
            self.capture.device_rate, self.capture.device_channels,
        )

    async def _on_cleanup(self, app: web.Application) -> None:
        # Cerrar todas las RTCPeerConnection activas y desuscribir del bus.
        coros = []
        for pc, q in list(self._peer_queues.items()):
            coros.append(pc.close())
            self.bus.unsubscribe(q)
        self._peer_queues.clear()
        if coros:
            await asyncio.gather(*coros, return_exceptions=True)
        self.bus.close()
        if self.capture:
            self.capture.stop()

    # --- handlers HTTP -----------------------------------------------------

    async def index_handler(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))

    async def offer_handler(self, request: web.Request) -> web.Response:
        """POST /offer — senalizacion WebRTC stateless."""
        try:
            params = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "JSON invalido"}, status=400)

        sdp = params.get("sdp")
        typ = params.get("type")
        if not sdp or typ != "offer":
            return web.json_response(
                {"error": "Se requiere sdp y type=offer"},
                status=400,
            )

        offer = RTCSessionDescription(sdp=sdp, type=typ)

        pc = RTCPeerConnection()
        peer_q = self.bus.subscribe()
        self._peer_queues[pc] = peer_q
        pc._cleanup_handle = None  # ponytail: timer para purge huérfanos

        def _cleanup_peer(p: RTCPeerConnection) -> None:
            q = self._peer_queues.pop(p, None)
            if q is not None:
                self.bus.unsubscribe(q)

        @pc.on("connectionstatechange")
        async def on_state_change() -> None:
            state = pc.connectionState
            # Cancelar timer pendiente si hay recovery.
            if getattr(pc, "_cleanup_handle", None) is not None:
                pc._cleanup_handle.cancel()
                pc._cleanup_handle = None

            if state in ("failed", "closed"):
                await pc.close()
                _cleanup_peer(pc)
            elif state == "disconnected":
                # ponytail: ICE drop. Si no recupera en PC_DISCONNECT_TIMEOUT,
                # cerramos para no retener referencias/eventos phantom.
                pc._cleanup_handle = asyncio.get_event_loop().call_later(
                    PC_DISCONNECT_TIMEOUT, lambda: asyncio.ensure_future(_purge(pc))
                )

        async def _purge(p: RTCPeerConnection) -> None:
            if p.connectionState in ("disconnected", "failed"):
                await p.close()
                _cleanup_peer(p)

        # Anadir nuestro CustomAudioTrack (audio capturado del PC).
        track = CustomAudioTrack(
            raw_queue=peer_q,
            device_rate=self.capture.device_rate,
            device_channels=self.capture.device_channels,
        )
        pc.addTrack(track)

        try:
            await pc.setRemoteDescription(offer)
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
        except Exception as exc:
            log.exception("Error en senalizacion WebRTC: %s", exc)
            await pc.close()
            _cleanup_peer(pc)
            return web.json_response(
                {"error": f"Fallo senalizacion: {exc}"},
                status=500,
            )

        local = pc.localDescription
        log.info("Cliente conectado (ICE=%s)", pc.iceGatheringState)

        return web.json_response(
            {"sdp": local.sdp, "type": local.type}
        )

    async def media_key_handler(self, request: web.Request) -> web.Response:
        """POST /api/pc/media-key — emula tecla Play/Pause en Windows con ctypes."""
        try:
            import ctypes
            VK_MEDIA_PLAY_PAUSE = 0xB3
            KEYEVENTF_KEYUP = 0x0002
            ctypes.windll.user32.keybd_event(VK_MEDIA_PLAY_PAUSE, 0, 0, 0)
            ctypes.windll.user32.keybd_event(VK_MEDIA_PLAY_PAUSE, 0, KEYEVENTF_KEYUP, 0)
            return web.json_response({"status": "ok", "action": "play_pause"})
        except Exception as exc:
            log.warning("Fallo al enviar tecla multimedia: %s", exc)
            return web.json_response({"error": str(exc)}, status=500)

    # --- run ---------------------------------------------------------------

    def run(self) -> None:
        web.run_app(
            self.app, host="0.0.0.0", port=self.port,
            access_log=None, shutdown_timeout=5.0, handle_signals=True,
        )


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )


def main() -> None:
    configure_logging()

    server = WebRTCServer(port=HTTP_PORT)
    try:
        server.run()
    except Exception as exc:
        log.exception("Cierre inesperado: %s", exc)


if __name__ == "__main__":
    main()
