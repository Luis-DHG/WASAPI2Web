"""Arranque todo-en-uno: motor Rust (WASAPI→Opus→WS) + pagina estatica + media key.

Run:
  python start.py

Sirve:
  http://<ip>:8080          -> static/index.html (cliente WS+WebCodecs)
  ws://<ip>:8090            -> frames binarios [seq:u32BE | ts:u32BE | opus]
  POST /api/pc/media-key    -> tecla Play/Pause global de Windows (ctypes)
"""

from __future__ import annotations

import ctypes
import http.server
import logging
import socket
import threading

from functools import partial

from pywebrtcsink_core import PyWasapiSinkEngine

log = logging.getLogger("pywebrtcsink")

HTTP_PORT = 8080
WS_PORT = 8090
WS_HOST = "0.0.0.0"
BITRATE = 96000


def get_local_ip(default: str = "127.0.0.1") -> str:
    """IP LAN del adaptador de salida por defecto.

    Prefiere 192.168.x/10.x sobre adaptadores virtuales (172.16.x de
    WARP/Hyper-V ganan la ruta por defecto y no son alcanzables desde LAN).
    """
    candidates: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("203.0.113.1", 80))
        candidates.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s2:
            s2.connect(("1.1.1.1", 80))
            candidates.append(s2.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ":" not in ip and not ip.startswith("127."):
                candidates.append(ip)
    except OSError:
        pass
    for prefix in ("192.168.", "10."):
        for ip in candidates:
            if ip.startswith(prefix):
                return ip
    for ip in candidates:
        return ip
    return default


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    def do_POST(self):
        if self.path == "/api/pc/media-key":
            try:
                VK_MEDIA_PLAY_PAUSE = 0xB3
                ctypes.windll.user32.keybd_event(VK_MEDIA_PLAY_PAUSE, 0, 0, 0)
                ctypes.windll.user32.keybd_event(VK_MEDIA_PLAY_PAUSE, 0, 0x0002, 0)
                self.send_response(200)
            except Exception as exc:
                log.warning("media-key fallo: %s", exc)
                self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_error(404)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    engine = PyWasapiSinkEngine()
    engine.start(host=WS_HOST, port=WS_PORT, bitrate=BITRATE)
    log.info("Motor Rust a la escucha -> ws://%s:%d (WS / Opus)", WS_HOST, WS_PORT)

    server = http.server.ThreadingHTTPServer(
        ("0.0.0.0", HTTP_PORT),
        partial(Handler, directory="static"),
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ip = get_local_ip()
    log.info("ABRILO EN EL MOVIL -> http://%s:%d", ip, HTTP_PORT)

    try:
        threading.Event().wait()  # dormir el main thread para siempre
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        engine.stop()
        log.info("Motor detenido.")


if __name__ == "__main__":
    main()
