"""Pruebas unitarias para CaptureBus (Opción A)."""

from __future__ import annotations

import asyncio
import unittest

from src.capture_bus import CaptureBus


class TestCaptureBus(unittest.TestCase):
    def test_invalid_maxsize(self) -> None:
        with self.assertRaises(ValueError):
            CaptureBus(maxsize=0)
        with self.assertRaises(ValueError):
            CaptureBus(maxsize=-10)

    def test_nominal_fanout(self) -> None:
        async def run() -> None:
            bus = CaptureBus(maxsize=10)
            q1 = bus.subscribe()
            q2 = bus.subscribe()
            self.assertEqual(bus.subscriber_count, 2)

            bus.publish(b"chunk1")
            bus.publish(b"chunk2")

            self.assertEqual(await q1.get(), b"chunk1")
            self.assertEqual(await q1.get(), b"chunk2")
            self.assertEqual(await q2.get(), b"chunk1")
            self.assertEqual(await q2.get(), b"chunk2")

        asyncio.run(run())

    def test_idempotent_unsubscribe(self) -> None:
        bus = CaptureBus(maxsize=10)
        q = bus.subscribe()
        self.assertEqual(bus.subscriber_count, 1)

        bus.unsubscribe(q)
        self.assertEqual(bus.subscriber_count, 0)

        # Repetición sin error (idempotente)
        bus.unsubscribe(q)
        bus.unsubscribe(None)
        self.assertEqual(bus.subscriber_count, 0)

    def test_drop_oldest_per_subscriber(self) -> None:
        async def run() -> None:
            bus = CaptureBus(maxsize=2)
            fast_q = bus.subscribe()
            slow_q = bus.subscribe()

            # Enviar 3 bloques a colas de maxsize 2
            bus.publish(b"block1")
            bus.publish(b"block2")
            bus.publish(b"block3")

            # El suscriptor lento debe haber descartado block1 y retener block2 y block3
            self.assertEqual(await slow_q.get(), b"block2")
            self.assertEqual(await slow_q.get(), b"block3")

            # El rápido lee normalmente
            self.assertEqual(await fast_q.get(), b"block2")
            self.assertEqual(await fast_q.get(), b"block3")

        asyncio.run(run())

    def test_zero_subscribers_and_invalid_type(self) -> None:
        bus = CaptureBus(maxsize=5)
        self.assertEqual(bus.subscriber_count, 0)
        # Publicar sin suscriptores no debe fallar
        bus.publish(b"alone")

        # Publicar tipos no válidos debe ser ignorado limpiamente sin lanzar excepción
        bus.publish(12345)  # type: ignore[arg-type]
        bus.publish(None)   # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
