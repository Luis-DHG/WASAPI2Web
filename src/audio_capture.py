"""Captura WASAPI Loopback con PyAudioWPatch.

Hebra dedicada lee bloques PCM del loopback del dispositivo de salida por
defecto y los publica en una cola asyncio para que el servidor los reenvie
a los WebSocket clientes.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from typing import Optional

import pyaudiowpatch as pyaudio

log = logging.getLogger("pyaudiobridge.audio")

# Formato de audio compartido por todo el pipeline.
SAMPLE_RATE = 44100
CHANNELS = 2
SAMPLE_WIDTH_BYTES = 2          # 16-bit signed
FORMAT = pyaudio.paInt16
FRAMES_PER_BLOCK = 2048         # ~46 ms de buffer a 44.1 kHz stereo
BLOCK_BYTES = FRAMES_PER_BLOCK * CHANNELS * SAMPLE_WIDTH_BYTES


@dataclass
class AudioFormat:
    sample_rate: int = SAMPLE_RATE
    channels: int = CHANNELS
    sample_width: int = SAMPLE_WIDTH_BYTES
    frames_per_block: int = FRAMES_PER_BLOCK

    @property
    def bytes_per_block(self) -> int:
        return self.frames_per_block * self.channels * self.sample_width


class AudioCaptureError(RuntimeError):
    """Errores de captura WASAPI."""


class WasapiLoopbackCapture:
    """Captura WASAPI loopback en una hebra propia.

    El bucle de captura corre en una hebra OS para no bloquear el event-loop
    de asyncio. Los bloques PCM se introducen en una `asyncio.Queue` mediante
    `loop.call_soon_threadsafe`. El servidor consume la cola y reenvia a los
    clientes conectados.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        queue: "asyncio.Queue[bytes]",
        audio_format: Optional[AudioFormat] = None,
        block_size: Optional[int] = None,
    ) -> None:
        self.loop = loop
        self.queue = queue
        self.fmt = audio_format or AudioFormat()
        self.block_size = block_size or self.fmt.frames_per_block
        self._pa: Optional[pyaudio.PyAudio] = None
        self._stream = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._device_name: str = "<desconocido>"

    @property
    def device_name(self) -> str:
        return self._device_name

    @property
    def format(self) -> AudioFormat:
        return self.fmt

    # --- listing -----------------------------------------------------------

    @staticmethod
    def list_loopback_devices() -> list[dict]:
        """Devuelve todos los dispositivos WASAPI loopback disponibles."""
        pa = pyaudio.PyAudio()
        try:
            return list(pa.get_loopback_device_info_generator())
        finally:
            pa.terminate()

    # --- lifecycle ---------------------------------------------------------

    def _resolve_loopback(self) -> dict:
        """Detecta el dispositivo de loopback por defecto."""
        assert self._pa is not None
        try:
            dev = self._pa.get_default_wasapi_loopback()
            log.info("Loopback por defecto: [%s] %s", dev["index"], dev["name"])
            return dev
        except LookupError as exc:
            raise AudioCaptureError(
                "No se encontro dispositivo WASAPI loopback. "
                "Ejecuta `python -m pyaudiowpatch` para listar dispositivos."
            ) from exc
        except OSError as exc:
            raise AudioCaptureError("WASAPI no disponible en este sistema.") from exc

    def start(self) -> None:
        if self._thread is not None:
            return
        self._pa = pyaudio.PyAudio()
        dev = self._resolve_loopback()
        self._device_name = dev["name"]

        device_rate = int(dev["defaultSampleRate"])
        device_channels = int(dev["maxInputChannels"])

        # Usar rate nativo del dispositivo (WASAPI shared mode puede
        # rechazar rates arbitrarios). El cliente recibe el rate real
        # via cabecera.
        if device_rate != self.fmt.sample_rate:
            log.info(
                "Device rate=%d, usando rate nativo (no %d).",
                device_rate, self.fmt.sample_rate,
            )
        actual_rate = device_rate
        actual_channels = device_channels
        if actual_channels < self.fmt.channels:
            log.warning(
                "Device channels=%d < 2; usando mono.",
                actual_channels,
            )
        else:
            actual_channels = self.fmt.channels

        self.fmt = AudioFormat(
            sample_rate=actual_rate,
            channels=actual_channels,
            sample_width=self.fmt.sample_width,
            frames_per_block=self.fmt.frames_per_block,
        )

        log.info(
            "Abriendo stream loopback rate=%d ch=%d block=%d",
            self.fmt.sample_rate, self.fmt.channels, self.block_size,
        )
        self._stream = self._pa.open(
            format=FORMAT,
            channels=self.fmt.channels,
            rate=self.fmt.sample_rate,
            input=True,
            input_device_index=dev["index"],
            frames_per_buffer=self.block_size,
        )
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="wasapi-capture", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
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

    # --- capture loop ------------------------------------------------------

    def _run(self) -> None:
        """Bucle de captura bloqueante en hebra dedicada."""
        log.info("Hebra de captura iniciada.")
        dropped = 0
        t0 = time.monotonic()
        blocks = 0
        while not self._stop.is_set():
            try:
                data = self._stream.read(
                    self.block_size, exception_on_overflow=False
                )
            except OSError as exc:
                log.warning("Error de lectura WASAPI: %s", exc)
                # Reintentamos tras breve espera para no quemar CPU.
                time.sleep(0.01)
                continue
            except Exception as exc:
                log.exception("Fallo inesperado en captura: %s", exc)
                break

            # Push thread-safe a la cola del event-loop. Si la cola esta
            # saturada (servidor lento / cliente pegado), descartamos el
            # bloque mas antiguo para mantener baja latencia (backpressure
            # en la fuente, complemento del descarte en el servidor).
            try:
                self.loop.call_soon_threadsafe(self._enqueue, data)
            except RuntimeError:
                # Event-loop cerrado: apagar.
                break

            blocks += 1
            if blocks % 500 == 0:
                elapsed = time.monotonic() - t0
                rate = blocks * self.block_size / elapsed
                log.debug(
                    "captura: %d bloques, %.1f bloques/s, descartados=%d",
                    blocks, rate, dropped,
                )
        log.info("Hebra de captura finalizada (bloques=%d, descartados=%d).",
                 blocks, dropped)

    def _enqueue(self, data: bytes) -> None:
        """Se ejecuta en el event-loop. Maneja backpressure de la cola."""
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self.queue.put_nowait(data)
        except asyncio.QueueFull:
            pass
