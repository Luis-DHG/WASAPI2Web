"""Utilidades de red y helpers para PyWebRTCSink."""

import socket


def get_local_ip(default: str = "127.0.0.1") -> str:
    """Resuelve la IP local (LAN) del host.

    Abre un socket UDP hacia una IP publica cualquiera (no envia paquetes
    realmente) y lee la direccion de origen del socket. Truco clasico y
    portable para obtener la IP de la interfaz de salida por defecto.
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
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

    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None):
            ip = info[4][0]
            if ":" not in ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return default
