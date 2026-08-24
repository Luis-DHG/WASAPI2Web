"""Captura WASAPI Loopback con PyAudioWPatch.

Hebra dedicada lee bloques PCM Int16 LE del loopback del dispositivo de
salida por defecto (lo que escuchas por altavoces/auriculares) y los
publica en un CaptureBus (fan-out a N CustomAudioTrack de aiortc).

Diseno:
  - Captura siempre el rate nativo del dispositivo (WASAPI shared mode).
  - El resampleo a 48 kHz (si el dispositivo no esta en 48k) se hace en
    el AudioTrack, no aqui, para no bloquear PortAudio.
  - Keepalive: si el loopback calla (Windows sin sesion de audio), una
    hebra lateral publica silencio sintetico para que el RTP nunca deje
    de fluir (estabiliza Wi-Fi/NAT/decodificador en el cliente movil).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import TYPE_CHECKING

import pyaudiowpatch as pyaudio

if TYPE_CHECKING:
    from .capture_bus import CaptureBus

log = logging.getLogger("pywertcsink.audio")

FORMAT = pyaudio.paInt16
SAMPLE_WIDTH_BYTES = 2
FRAMES_PER_BLOCK = 960   # 20ms @ 48kHz — baja latencia para WebRTC


class AudioCaptureError(RuntimeError):
    """Error de captura WASAPI."""


class WasapiLoopbackCapture:
    """Captura WASAPI loopback en hebra propia.

    Publica bloques PCM (bytes Int16 LE) en un CaptureBus para los AudioTracks.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        bus: CaptureBus,
    ) -> None:
        self.loop = loop
        self.bus = bus
        self._pa: pyaudio.PyAudio | None = None
        self._stream = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._device_name: str = "<desconocido>"
        self._device_rate: int = 48000
        self._device_channels: int = 2
        self._block_size: int = FRAMES_PER_BLOCK
        self._silent_block: bytes = b""
        self._last_pub: float = 0.0
        self._ka_thread: threading.Thread | None = None

    @property
    def device_name(self) -> str:
        return self._device_name

    @property
    def device_rate(self) -> int:
        return self._device_rate

    @property
    def device_channels(self) -> int:
        return self._device_channels

    def _resolve_loopback(self) -> dict:
        assert self._pa is not None
        try:
            return self._pa.get_default_wasapi_loopback()
        except LookupError as exc:
            raise AudioCaptureError(
                "No se encontro dispositivo WASAPI loopback."
            ) from exc

    def start(self) -> None:
        if self._thread is not None:
            return
        self._pa = pyaudio.PyAudio()
        dev = self._resolve_loopback()
        self._device_name = dev["name"]
        self._device_rate = int(dev["defaultSampleRate"])
        self._device_channels = int(dev["maxInputChannels"])
        if self._device_channels < 1:
            self._device_channels = 1

        self._stream = self._pa.open(
            format=FORMAT,
            channels=self._device_channels,
            rate=self._device_rate,
            input=True,
            input_device_index=dev["index"],
            frames_per_buffer=self._block_size,
        )
        self._stop.clear()
        self._last_pub = time.monotonic()
        # Bloque de silencio: frames x canales x bytes/sample (20ms @ rate nativo).
        self._silent_block = b"\x00" * (
            FRAMES_PER_BLOCK * self._device_channels * SAMPLE_WIDTH_BYTES
        )
        self._thread = threading.Thread(
            target=self._run, name="wasapi-capture", daemon=True
        )
        self._ka_thread = threading.Thread(
            target=self._keepalive_run, name="wasapi-keepalive", daemon=True
        )
        self._thread.start()
        self._ka_thread.start()

    def stop(self) -> None:
        self._stop.set()
        for attr in ("_thread", "_ka_thread"):
            t: threading.Thread | None = getattr(self, attr)
            if t is not None:
                t.join(timeout=2.0)
                setattr(self, attr, None)
        if self._stream is not None:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._pa is not None:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                data = self._stream.read(
                    self._block_size, exception_on_overflow=False
                )
            except OSError as exc:
                log.warning("Error de lectura WASAPI: %s", exc)
                time.sleep(0.01)
                continue
            except Exception:
                log.exception("Fallo inesperado en captura")
                break

            try:
                self.loop.call_soon_threadsafe(self._on_loop_publish, data)
            except RuntimeError:
                break

    def _keepalive_run(self) -> None:
        # ponytail: WASAPI calla cuando Windows no tiene sesión de audio; publicamos
        # silencio sintético para que el RTP nunca deje de fluir (fix bug pantalla
        # apagada — ver alternativas.md §B). Umbral 200ms >> gap real de 20ms.
        while not self._stop.wait(0.1):
            if time.monotonic() - self._last_pub < 0.2:
                continue
            try:
                self.loop.call_soon_threadsafe(
                    self._on_loop_publish, self._silent_block
                )
            except RuntimeError:
                break

    def _on_loop_publish(self, data: bytes) -> None:
        """publish en el event loop + marca de tiempo para el keepalive."""
        self.bus.publish(data)
        self._last_pub = time.monotonic()
