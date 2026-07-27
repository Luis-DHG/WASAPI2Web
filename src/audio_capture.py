"""Captura WASAPI Loopback con PyAudioWPatch + pipeline de procesamiento.

Hebra dedicada lee bloques PCM del loopback del dispositivo de salida por
defecto. Un `BlockProcessor` aplica mono mix, RMS, skip silencio y timestamps
segun la configuracion negociada por el servidor para cada cliente, y publica
bloques listos para enviar en una cola asyncio.

Diseno:
  - Captura siempre el rate nativo del dispositivo (WASAPI shared mode no
    acepta rates arbitrarios). Solo se soporta 48 kHz (o el nativo).
  - Procesamiento en el event-loop (async), no en la hebra de captura,
    para no bloquear PortAudio.
  - Cada bloque lleva cabecera de 8 bytes (uint32 LE ts_ms + uint32 flags).
  - Solo codec PCM Int16 LE. Sin mu-law, sin downsample (no necesario en LAN).
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

# Formato nativo del hardware (WASAPI lo decide).
FORMAT = pyaudio.paInt16
SAMPLE_WIDTH_BYTES = 2
FRAMES_PER_BLOCK = 2048

# Codec unico.
CODEC_PCM = 0

# Cabecera de bloque: uint32 ts_ms + uint32 flags (reservado).
BLOCK_HEADER_BYTES = 8


@dataclass
class AudioFormat:
    """Formato de audio negociado para un cliente."""
    sample_rate: int = 48000
    channels: int = 2
    sample_width: int = SAMPLE_WIDTH_BYTES
    codec: int = CODEC_PCM
    frames_per_block: int = FRAMES_PER_BLOCK

    @property
    def bytes_per_block(self) -> int:
        return self.frames_per_block * self.channels * self.sample_width


class AudioCaptureError(RuntimeError):
    """Errores de captura WASAPI."""


# ---------------------------------------------------------------------------
# Bloque procesado (payload final listo para WS)
# ---------------------------------------------------------------------------

@dataclass
class ProcessedBlock:
    """Bloque listo para enviar a clientes de un formato dado."""
    seq: int
    ts_ms: int                      # timestamp de captura (ms monotonicos)
    payload: bytes                  # bytes PCM Int16 LE sin cabecera
    is_silence: bool = False
    rms: float = 0.0                # 0..1 (promedio RMS del bloque)


# ---------------------------------------------------------------------------
# Captura
# ---------------------------------------------------------------------------

class WasapiLoopbackCapture:
    """Captura WASAPI loopback en una hebra propia.

    Publica bloques PCM crudos (Int16 LE, rate nativo, stereo) en la cola
    `raw_queue`. El servidor los procesa por formato de cliente.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        raw_queue: "asyncio.Queue[tuple[int, int, bytes]]",
    ) -> None:
        self.loop = loop
        self.raw_queue = raw_queue
        self._pa: Optional[pyaudio.PyAudio] = None
        self._stream = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._device_name: str = "<desconocido>"
        self._device_rate: int = 48000
        self._device_channels: int = 2
        self._block_size: int = FRAMES_PER_BLOCK
        self._seq_counter = 0
        self._t0_mono = time.monotonic()

    @property
    def device_name(self) -> str:
        return self._device_name

    @property
    def device_rate(self) -> int:
        return self._device_rate

    @property
    def device_channels(self) -> int:
        return self._device_channels

    @property
    def block_size(self) -> int:
        return self._block_size

    # --- listing -----------------------------------------------------------

    @staticmethod
    def list_loopback_devices() -> list[dict]:
        pa = pyaudio.PyAudio()
        try:
            return list(pa.get_loopback_device_info_generator())
        finally:
            pa.terminate()

    # --- lifecycle ---------------------------------------------------------

    def _resolve_loopback(self) -> dict:
        assert self._pa is not None
        try:
            dev = self._pa.get_default_wasapi_loopback()
            log.info("Loopback por defecto: [%s] %s", dev["index"], dev["name"])
            return dev
        except LookupError as exc:
            raise AudioCaptureError(
                "No se encontro dispositivo WASAPI loopback."
            ) from exc
        except OSError as exc:
            raise AudioCaptureError("WASAPI no disponible.") from exc

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

        log.info(
            "Abriendo stream loopback rate=%d ch=%d block=%d",
            self._device_rate, self._device_channels, self._block_size,
        )
        self._stream = self._pa.open(
            format=FORMAT,
            channels=self._device_channels,
            rate=self._device_rate,
            input=True,
            input_device_index=dev["index"],
            frames_per_buffer=self._block_size,
        )
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="wasapi-capture", daemon=True
        )
        self._thread.start()
        self._t0_mono = time.monotonic()

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

    def is_running(self) -> bool:
        """True si la hebra de captura esta viva y no marcada para parar."""
        return (
            self._thread is not None
            and self._thread.is_alive()
            and not self._stop.is_set()
        )

    # --- capture loop ------------------------------------------------------

    def _run(self) -> None:
        log.info("Hebra de captura iniciada.")
        blocks = 0
        t0 = time.monotonic()
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

            self._seq_counter += 1
            ts_ms = int((time.monotonic() - self._t0_mono) * 1000)
            try:
                self.loop.call_soon_threadsafe(
                    self._enqueue, (self._seq_counter, ts_ms, data)
                )
            except RuntimeError:
                break

            blocks += 1
            if blocks % 1000 == 0:
                elapsed = time.monotonic() - t0
                log.debug(
                    "captura: %d bloques, %.1f bloques/s",
                    blocks, blocks / elapsed,
                )
        log.info("Hebra de captura finalizada (bloques=%d).", blocks)

    def _enqueue(self, item: tuple[int, int, bytes]) -> None:
        if self.raw_queue.full():
            try:
                self.raw_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self.raw_queue.put_nowait(item)
        except asyncio.QueueFull:
            pass


# ---------------------------------------------------------------------------
# Procesador (server-side, una instancia por formato negociado)
# ---------------------------------------------------------------------------

class BlockProcessor:
    """Transforma bloques PCM crudos al formato de un cliente.

    Entrada: (seq, ts_ms, pcm_int16_le) en rate nativo stereo (o mono).
    Salida: ProcessedBlock con payload PCM Int16 LE en el formato negociado.

    Aplica: mono mix, skip silencio, calculo RMS. Sin downsample, sin codec
    alternativo (LAN asume 48 kHz nativo + PCM).
    """

    def __init__(self, fmt: AudioFormat, device_rate: int, device_channels: int,
                 skip_silence: bool = True,
                 silence_threshold: float = 0.01,
                 silence_min_ms: int = 500) -> None:
        self.fmt = fmt
        self.device_rate = device_rate
        self.device_channels = device_channels
        self.skip_silence = skip_silence
        self.silence_threshold = silence_threshold
        self.silence_min_ms = silence_min_ms
        self._silence_since: Optional[float] = None

    def process(self, seq: int, ts_ms: int, pcm: bytes) -> Optional[ProcessedBlock]:
        """Procesa un bloque crudo. Devuelve None si se descarta por silencio."""
        n_samples = len(pcm) // 2
        if n_samples < 2:
            return None

        channels = self.device_channels
        decoded = pcm

        # 1. Mono mix si aplica (promedio de canales del dispositivo).
        if self.fmt.channels == 1 and channels > 1:
            decoded = self._mix_to_mono(decoded, channels)
            channels = 1

        # 2. RMS para deteccion de silencio y metricas.
        rms = self._compute_rms(decoded, channels)
        is_silence = rms < self.silence_threshold
        now = time.monotonic()

        if is_silence and self.skip_silence:
            if self._silence_since is None:
                self._silence_since = now
            silence_ms = (now - self._silence_since) * 1000
            if silence_ms > self.silence_min_ms:
                return ProcessedBlock(seq=seq, ts_ms=ts_ms, payload=b"",
                                       is_silence=True, rms=rms)
        else:
            self._silence_since = None

        return ProcessedBlock(seq=seq, ts_ms=ts_ms, payload=decoded,
                              is_silence=False, rms=rms)

    def _mix_to_mono(self, pcm: bytes, channels: int) -> bytes:
        if channels == 1:
            return pcm
        n_frames = (len(pcm) // 2) // channels
        out = bytearray(n_frames * 2)
        for f in range(n_frames):
            acc = 0
            for c in range(channels):
                lo = pcm[(f * channels + c) * 2]
                hi = pcm[(f * channels + c) * 2 + 1]
                s = (hi << 8) | lo
                if s >= 32768:
                    s -= 65536
                acc += s
            m = acc // channels
            if m < -32768:
                m = -32768
            elif m > 32767:
                m = 32767
            um = m & 0xFFFF
            out[f * 2] = um & 0xFF
            out[f * 2 + 1] = (um >> 8) & 0xFF
        return bytes(out)

    def _compute_rms(self, pcm: bytes, channels: int) -> float:
        n = len(pcm) // 2
        if n == 0:
            return 0.0
        sum_sq = 0
        stride = max(1, n // 512)
        count = 0
        for i in range(0, n, stride):
            lo = pcm[i * 2]
            hi = pcm[i * 2 + 1]
            s = (hi << 8) | lo
            if s >= 32768:
                s -= 65536
            sum_sq += s * s
            count += 1
        if count == 0:
            return 0.0
        mean_sq = sum_sq / count
        return ((mean_sq ** 0.5) / 32768.0)
