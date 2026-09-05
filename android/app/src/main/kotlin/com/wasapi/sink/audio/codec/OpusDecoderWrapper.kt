package com.wasapi.sink.audio.codec

import android.util.Log
import io.github.jaredmdobson.concentus.OpusDecoder
import io.github.jaredmdobson.concentus.OpusException
import java.nio.ByteBuffer

private const val TAG = "OpusDecoderWrapper"

/**
 * Wrapper zero-alloc del decoder Concentus: DirectByteBuffer → DirectByteBuffer
 * para AudioTrack, con arrays reutilizados para no generar GC en runtime.
 */
class OpusDecoderWrapper(
    val sampleRate: Int = 48000,
    val channels: Int = 2
) {
    private var decoder: OpusDecoder? = null

    // Pre-allocated reusable arrays to eliminate GC pressure
    private val rawInputArray = ByteArray(1500)
    private val rawOutputArray = ShortArray(960 * 2) // 20ms @ 48kHz stereo = 1920 samples

    init {
        try {
            decoder = OpusDecoder(sampleRate, channels)
            Log.i(TAG, "OpusDecoder initialized ($sampleRate Hz, $channels channels)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize OpusDecoder: ${e.message}", e)
            throw e
        }
    }

    /**
     * Decodifica un frame Opus directo al ByteBuffer de salida para AudioTrack.
     * @param input Buffer con el paquete; NO se muta su position final.
     * @param inputOffset Offset del payload dentro del input.
     * @param inputSize Tamaño del payload Opus en bytes.
     * @param outputByteBuffer Buffer destino PCM 16-bit (queda listo para escribir).
     * @param frameSize Muestras por canal (960 para 20ms @ 48kHz).
     * @param decodeFEC Si true, decodifica el FEC inband (PLC del frame previo).
     * @return Muestras por canal decodificadas, o negativo en error.
     */
    fun decodeToByteBuffer(
        input: ByteBuffer,
        inputOffset: Int,
        inputSize: Int,
        outputByteBuffer: ByteBuffer,
        frameSize: Int = 960,
        decodeFEC: Boolean = false
    ): Int {
        val dec = decoder ?: return -1
        val decoded = try {
            val originalPos = input.position()
            input.position(inputOffset)
            input.get(rawInputArray, 0, inputSize)
            input.position(originalPos)
            dec.decode(rawInputArray, 0, inputSize, rawOutputArray, 0, frameSize, decodeFEC)
        } catch (e: OpusException) {
            Log.e(TAG, "Opus decoding error: ${e.message}")
            -1
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error during Opus decode: ${e.message}", e)
            -1
        }

        if (decoded > 0) {
            val totalShorts = decoded * channels
            outputByteBuffer.clear()
            outputByteBuffer.asShortBuffer().put(rawOutputArray, 0, totalShorts)
            outputByteBuffer.position(0)
            outputByteBuffer.limit(totalShorts * 2)
        }
        return decoded
    }

    fun release() {
        decoder = null
    }
}
