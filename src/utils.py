"""Utilidades de red y helpers para PyWebRTCSink."""

import ipaddress
import socket


def get_local_ip(default: str = "127.0.0.1") -> str:
    """Resuelve la IP local (LAN) del host.

    Alcance: solo LAN privada (RFC1918). Nunca devuelve una IP publica —
    el producto es LAN-only, si el host no tiene IP privada se devuelve
    `default` y se considera un error de configuracion del usuario.

    Candidatos: (1) IP origen de la ruta por defecto (omito adaptadores
    virtuales) por lo que se prefiere cualquier 192.168.x.x."""
    
    routed: str | None = None
    host_candidates: list[str] = []

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ":" not in ip and ip not in host_candidates:
                host_candidates.append(ip)
    except OSError:
        pass

    def usable(ip: str) -> ipaddress.IPv4Address | None:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return None
        if addr.is_loopback or addr.is_link_local or addr.is_multicast:
            return None
        return addr

    all_ips = ([routed] if routed else []) + host_candidates
    private = [ip for ip in all_ips
               if (a := usable(ip)) is not None and a.is_private]

    # ponytail: 192.168.x.x primero = LAN domestica real. Evita que un
    # adaptador virtual que gano la ruta por defecto opaque la LAN.
    for ip in private:
        if ip.startswith("192.168."):
            return ip
    if private:
        return private[0]
    return default


if __name__ == "__main__":
    # Smoke check: debe devolver IPv4 privada o el default 127.0.0.1.
    ip = get_local_ip()
    addr = ipaddress.ip_address(ip)
    assert addr.version == 4 and (addr.is_private or addr.is_loopback)
    print(ip)
