package com.wasapi.sink.audio.codec

import android.util.Log
import io.github.jaredmdobson.concentus.OpusDecoder
import io.github.jaredmdobson.concentus.OpusException
import java.nio.ByteBuffer

private const val TAG = "OpusDecoderWrapper"

/**
 * High-performance Opus Decoder wrapper for 48kHz stereo streams.
 * Engineered for zero GC allocations during real-time decoding.
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
     * Decodes an Opus frame from a DirectByteBuffer into a ShortArray.
     * @param input Buffer containing the Opus packet payload.
     * @param inputOffset Starting offset within the input buffer.
     * @param inputSize Length of the Opus compressed payload in bytes.
     * @param outputShorts Pre-allocated array to receive PCM 16-bit samples.
     * @param outputOffset Offset in outputShorts where decoded samples will be placed.
     * @param frameSize Muestras por canal (960 para 20ms @ 48kHz).
     * @param decodeFEC Si true, decodifica el FEC inband del paquete (PLC del frame previo); si no, frame normal.
     * @return Number of samples per channel decoded, or negative on error.
     */
    fun decode(
        input: ByteBuffer,
        inputOffset: Int,
        inputSize: Int,
        outputShorts: ShortArray,
        outputOffset: Int = 0,
        frameSize: Int = 960,
        decodeFEC: Boolean = false
    ): Int {
        val dec = decoder ?: return -1
        return try {
            val originalPos = input.position()
            input.position(inputOffset)
            input.get(rawInputArray, 0, inputSize)
            input.position(originalPos)

            val decoded = dec.decode(
                rawInputArray,
                0,
                inputSize,
                outputShorts,
                outputOffset,
                frameSize,
                decodeFEC
            )
            decoded
        } catch (e: OpusException) {
            Log.e(TAG, "Opus decoding error: ${e.message}")
            -1
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error during Opus decode: ${e.message}", e)
            -1
        }
    }

    /**
     * Decodes directly into a DirectByteBuffer for AudioTrack consumption.
     */
    fun decodeToByteBuffer(
        input: ByteBuffer,
        inputOffset: Int,
        inputSize: Int,
        outputByteBuffer: ByteBuffer,
        frameSize: Int = 960,
        decodeFEC: Boolean = false
    ): Int {
        val samplesDecodedPerChannel = decode(
            input,
            inputOffset,
            inputSize,
            rawOutputArray,
            0,
            frameSize,
            decodeFEC
        )

        if (samplesDecodedPerChannel > 0) {
            val totalShorts = samplesDecodedPerChannel * channels
            val totalBytes = totalShorts * 2

            outputByteBuffer.clear()
            val shortBuf = outputByteBuffer.asShortBuffer()
            shortBuf.put(rawOutputArray, 0, totalShorts)
            outputByteBuffer.position(0)
            outputByteBuffer.limit(totalBytes)
        }

        return samplesDecodedPerChannel
    }

    fun release() {
        decoder = null
    }
}
