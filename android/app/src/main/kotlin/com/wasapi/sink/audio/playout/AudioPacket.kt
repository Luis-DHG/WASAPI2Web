package com.wasapi.sink.audio.playout

import java.nio.ByteBuffer

/**
 * Paquete de audio que circula WS → pool → PlayoutBuffer → decoder.
 * Vive en playout (y no dentro del Engine) para que la politica sea
 * testeable en JVM sin cargar clases de Android.
 */
class AudioPacket(
    val buffer: ByteBuffer,
    var sequenceNumber: Long = 0L,
    var payloadSize: Int = 0
)
