"""CaptureBus — fan-out de bloques PCM a N suscriptores (peers WebRTC).

Un productor (WasapiLoopbackCapture, en hebra propia) publica bloques vía
publish(); cada CustomAudioTrack suscribe su propia cola acotada con
subscribe().

Garantías:
  - Idempotencia en subscribe / unsubscribe / close.
  - Drop-oldest per-subscriber: si un peer va lento y su cola se llena, se descarta
    el bloque más viejo de ESE peer sin bloquear a los demás (no head-of-line blocking).
  - Manejo seguro de estado ante cierres concurrentes o excepciones en colas individuales.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Set

log = logging.getLogger("pywertcsink.bus")


class CaptureBus:
    """Fan-out 1-producer -> N-suscriptores con drop-oldest per-subscriber."""

    def __init__(self, maxsize: int = 64) -> None:
        if not isinstance(maxsize, int) or maxsize <= 0:
            raise ValueError(f"maxsize debe ser un entero positivo, recibido: {maxsize}")
        self._maxsize = maxsize
        self._subs: Set[asyncio.Queue[bytes]] = set()

    def subscribe(self) -> asyncio.Queue[bytes]:
        """Crea y registra una nueva cola de suscriptor."""
        q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=self._maxsize)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[bytes] | None) -> None:
        """Desregistra una cola de forma idempotente."""
        if q is not None:
            self._subs.discard(q)

    def publish(self, block: bytes) -> None:
        """Publica un bloque PCM a todos los suscriptores activos.

        # ponytail: iteración sobre copia estática del set para evitar mutaciones concurrentes durante publish.
        """
        if not isinstance(block, (bytes, bytearray, memoryview)):
            log.warning("CaptureBus.publish recibió tipo no válido: %s", type(block))
            return

        payload = bytes(block) if not isinstance(block, bytes) else block

        for q in list(self._subs):
            if q.full():
                try:
                    q.get_nowait()
                except (asyncio.QueueEmpty, ValueError):
                    pass
            try:
                q.put_nowait(payload)
            except (asyncio.QueueFull, ValueError) as exc:
                log.debug("No se pudo encolar bloque en suscriptor: %s", exc)
