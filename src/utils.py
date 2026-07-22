"""Utilidades de red y helpers para PyAudioBridge."""

import socket
from typing import Optional


def get_local_ip(default: str = "127.0.0.1") -> str:
    """Resuelve la IP local (LAN) del host.

    Abre un socket UDP hacia una IP publica cualquiera (no envia paquetes
    realmente) y lee la direccion de origen del socket. Truco clasico y
    portable para obtener la IP de la interfaz de salida por defecto.
    """
    sock: Optional[socket.socket] = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        # 203.0.113.1 es rango TEST-NET, no enrutable. Solo nos interesa
        # que el SO elija la interfaz de salida.
        sock.connect(("203.0.113.1", 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("169.254"):
            return ip
    except OSError:
        pass
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    # Fallback: iterar interfaces via getaddrinfo/gethostname.
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None):
            ip = info[4][0]
            if ":" not in ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return default


def format_size(n: int) -> str:
    """Representacion legible de bytes."""
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TiB"
