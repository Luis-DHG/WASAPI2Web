"""Utilidades de red y helpers para PyWebRTCSink."""

import socket


def get_local_ip(default: str = "127.0.0.1") -> str:
    """Resuelve la IP local (LAN) del host.

    Junta candidatos de dos fuentes (truco del socket UDP hacia una IP
    publica + getaddrinfo del hostname) y elige la de red privada LAN,
    prefiriendo 192.168.x.x sobre adaptadores virtuales (172.16.x de
    WSL/Hyper-V/VPN suelen ganar la ruta por defecto).
    """
    candidates: list[str] = []

    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.connect(("203.0.113.1", 80))
        candidates.append(sock.getsockname()[0])
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
                candidates.append(ip)
    except OSError:
        pass

    # ponytail: orden fijo por subred; si tu LAN usa otro rango, agregarlo arriba.
    for prefix in ("192.168.", "10."):
        for ip in candidates:
            if ip.startswith(prefix):
                return ip
    for ip in candidates:
        if not ip.startswith("169.254"):
            return ip
    return default
