"""CustomAudioTrack — subclase de aiortc.MediaStreamTrack.

Consume bloques PCM Int16 LE de una asyncio.Queue (alimentada por
WasapiLoopbackCapture), los resamplea a 48 kHz si el dispositivo no esta
en 48k, y produce av.AudioFrame consumidos por el codificador Opus
interno de aiortc.

Puntos clave:
  - aiortc llama a recv() en bucle async dentro de su track handler.
  - av.AudioResampler tiene buffer interno; puede requerir varios
    chunks de entrada antes de emitir un frame de salida.
  - PTS (presentation timestamp) debe ser monotonico y usar
    time_base = 1/48000 — aiortc exige esto para el muxer RTP.
"""

from __future__ import annotations

import asyncio
import fractions
import logging

import av
from aiortc import MediaStreamTrack

log = logging.getLogger("pywertcsink.track")

TARGET_RATE = 48000          # Opus exige 48k
TARGET_LAYOUT = "stereo"
SAMPLE_WIDTH = 2             # Int16 = 2 bytes


class CustomAudioTrack(MediaStreamTrack):
    """Track de audio que envia bloques PCM capturados via WebRTC.

    Args:
        raw_queue: Cola async con bytes PCM Int16 LE.
        device_rate: Sample rate del dispositivo WASAPI (ej: 44100 o 48000).
        device_channels: Numero de canales del dispositivo (1 o 2).
    """

    kind = "audio"

    def __init__(
        self,
        raw_queue: "asyncio.Queue[bytes]",
        device_rate: int,
        device_channels: int = 2,
    ) -> None:
        super().__init__()
        self._queue = raw_queue
        self._device_rate = device_rate
        self._device_channels = device_channels
        self._samples_sent = 0
        self._resampler = None
        self._layout = "stereo" if device_channels == 2 else "mono"
        if device_rate != TARGET_RATE:
            self._resampler = av.AudioResampler(
                format="s16",
                layout=TARGET_LAYOUT,
                rate=TARGET_RATE,
            )

    async def recv(self) -> av.AudioFrame:
        """Devuelve el siguiente AudioFrame a 48kHz para aiortc."""
        # 1. Leer chunk PCM crudo (Int16 LE) de la cola.
        pcm_bytes = await self._queue.get()

        # 2. Construir AudioFrame s16 packed desde bytes (sin numpy).
        #    Layout s16 packed: 1 plano, samples = total_frames.
        total_samples = len(pcm_bytes) // (SAMPLE_WIDTH * self._device_channels)
        in_frame = av.AudioFrame(
            format="s16", layout=self._layout, samples=total_samples,
        )
        in_frame.planes[0].update(pcm_bytes)
        in_frame.sample_rate = self._device_rate

        # 3. Resamplear si el dispositivo no esta en 48k.
        if self._resampler is not None:
            out_frames = self._resampler.resample(in_frame)
            if not out_frames:
                # El buffer interno del resampler aun no tiene suficiente
                # data para emitir un frame completo. Recursivamente
                # pedir mas chunks hasta tener uno.
                return await self.recv()
            # resample puede devolver varios frames; usar el primero.
            frame = out_frames[0]
        else:
            frame = in_frame

        # 4. Asignar PTS monotonico + time_base 1/48000.
        frame.pts = self._samples_sent
        frame.time_base = fractions.Fraction(1, TARGET_RATE)
        self._samples_sent += frame.samples

        return frame
