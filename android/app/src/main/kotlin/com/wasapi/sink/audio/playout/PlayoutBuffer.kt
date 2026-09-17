package com.wasapi.sink.audio.playout

import com.wasapi.sink.audio.playout.AudioPacket

/** Qué debe sonar a continuación. El Engine es solo el ejecutor de esto. */
sealed interface PlayoutDecision {
    data class Play(val packet: AudioPacket) : PlayoutDecision

    /** Hueco de seq: N frames de PLC y luego el paquete, primero con FEC
     *  (recupera el inmediato anterior) y después el decode normal. */
    data class Gap(val plcFrames: Int, val packet: AudioPacket) : PlayoutDecision

    /** Cola vacía: el Engine debe escribir silencio al HAL, no callar. */
    data object Idle : PlayoutDecision
}

/**
 * Política de playout: qué se oye cuando falta un paquete.
 *
 * Kotlin puro, sin dependencias de Android ni OkHttp: testeable en JVM con
 * paquetes sintéticos. Solo mueve referencias; el pool de DirectByteBuffers
 * vive en el Engine. Los paquetes descartados salen por [onDiscard] para que
 * el Engine los devuelva al pool.
 *
 * Política (números acordados, ver plan):
 * - Objetivo de profundidad: 4 frames (80 ms de jitter estacionario).
 * - Drenaje gradual: si la profundidad pasa de TARGET+2, descarta 1 frame
 *   cada DRAIN_INTERVAL_MS. Nunca en bloque (eso oscilaba).
 * - Resync duro: si supera MAX_DEPTH, saltar al target (cliente quedó
 *   permanentemente atrasado; más vale el corte).
 * - Huecos de seq: PLC para los perdidos (cap 3) y FEC del paquete actual
 *   para el inmediato anterior.
 */
class PlayoutBuffer(
    val targetDepth: Int = TARGET_DEPTH_FRAMES,
    private val maxDepth: Int = MAX_DEPTH_FRAMES,
) {
    companion object {
        const val TARGET_DEPTH_FRAMES = 4   // 80 ms — acordado
        const val MAX_DEPTH_FRAMES = 14     // 280 ms; por encima, resync duro
        const val CAPACITY = 16             // contenedor; siempre > MAX_DEPTH
        const val DRAIN_INTERVAL_MS = 250L  // catch-up gradual
        const val PLC_CAP = 3
    }

    var onDiscard: ((AudioPacket) -> Unit)? = null

    private val queue = ArrayDeque<AudioPacket>(CAPACITY)
    private var lastSeq = -1L
    private var lastDrainAt = 0L

    // Contadores locales (telemetría; sin canal de reporte).
    var gapEvents = 0L; private set
    var plcGenerated = 0L; private set
    var drainedForCatchUp = 0L; private set
    var hardResyncs = 0; private set

    val depth: Int @Synchronized get() = queue.size

    @Synchronized
    fun reset() {
        while (queue.isNotEmpty()) queue.removeFirst().let { onDiscard?.invoke(it) }
        lastSeq = -1L
        lastDrainAt = 0L
    }

    /**
     * Desde el hilo de red. Devuelve el paquete expulsado (cola llena) para
     * que el Engine lo recicle, o null si entró limpio.
     */
    @Synchronized
    fun offer(packet: AudioPacket): AudioPacket? {
        val evicted = if (queue.size >= CAPACITY) queue.removeFirstOrNull() else null
        queue.addLast(packet)
        return evicted
    }

    /** Desde el hilo de audio, una vez por tick (~20 ms). */
    @Synchronized
    fun poll(nowMs: Long): PlayoutDecision {
        // Drenaje gradual bajo ráfaga: 1 frame por intervalo mientras esté
        // por encima del objetivo + margen. El hueco lo tapa el FEC/PLC del
        // siguiente frame; drenar de golpe creaba huecos multi-frame.
        if (queue.size > targetDepth + 2 && nowMs - lastDrainAt >= DRAIN_INTERVAL_MS) {
            lastDrainAt = nowMs
            queue.removeFirstOrNull()?.let { onDiscard?.invoke(it); drainedForCatchUp++ }
        }

        // Resync duro: profundidad insalvable → saltar al target.
        if (queue.size > maxDepth) {
            while (queue.size > targetDepth) {
                queue.removeFirstOrNull()?.let { onDiscard?.invoke(it); drainedForCatchUp++ }
            }
            hardResyncs++
        }

        val next = queue.removeFirstOrNull() ?: return PlayoutDecision.Idle

        if (lastSeq == -1L) {
            lastSeq = next.sequenceNumber
            return PlayoutDecision.Play(next)
        }

        val gap = next.sequenceNumber - lastSeq - 1
        if (gap <= 0) {
            lastSeq = next.sequenceNumber
            return PlayoutDecision.Play(next)
        }

        gapEvents++
        // PLC por los perdidos salvo el inmediato anterior, que lo recupera
        // el FEC inband del paquete actual.
        val plc = (gap - 1).toInt().coerceIn(0, PLC_CAP)
        plcGenerated += plc.toLong()
        lastSeq = next.sequenceNumber
        return PlayoutDecision.Gap(plcFrames = plc, packet = next)
    }
}
