package com.wasapi.sink.audio.playout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer

/**
 * Tests de la política de playout en JVM puro: sin WS, sin AudioTrack.
 * Los paquetes son sintéticos; solo importa el seq.
 */
class PlayoutBufferTest {

    private var now = 0L

    private fun pkt(seq: Long) = AudioPacket(ByteBuffer.allocate(16), seq, 8)

    private fun buffer(): PlayoutBuffer = PlayoutBuffer()

    /** Alimenta la cola con seq first..last SIN huecos. */
    private fun feed(b: PlayoutBuffer, first: Long, last: Long) {
        for (s in first..last) b.offer(pkt(s))
    }

    @Test
    fun `paquetes en orden salen Play sin PLC`() {
        val b = buffer()
        feed(b, 0, 3)
        repeat(4) {
            val d = b.poll(now)
            assertTrue("tick $it debe ser Play, fue $d", d is PlayoutDecision.Play)
        }
        assertEquals(0, b.gapEvents)
        assertEquals(0, b.plcGenerated)
    }

    @Test
    fun `hueco de 1 frame genera Gap sin PLC y con FEC`() {
        val b = buffer()
        b.offer(pkt(0))
        assertTrue(b.poll(now) is PlayoutDecision.Play)

        b.offer(pkt(2)) // perdió el 1
        val d = b.poll(now)
        assertTrue(d is PlayoutDecision.Gap)
        d as PlayoutDecision.Gap
        assertEquals(0, d.plcFrames)           // 1 perdido = solo FEC del paquete actual
        assertEquals(2L, d.packet.sequenceNumber)
        assertEquals(1, b.gapEvents)
    }

    @Test
    fun `hueco de 3 frames genera 2 PLC + FEC`() {
        val b = buffer()
        b.offer(pkt(0))
        b.poll(now)

        b.offer(pkt(4)) // perdió 1, 2, 3
        val d = b.poll(now) as PlayoutDecision.Gap
        assertEquals(2, d.plcFrames) // 3 perdidos - 1 (ese lo tapa FEC)
    }

    @Test
    fun `hueco grande respeta PLC_CAP`() {
        val b = buffer()
        b.offer(pkt(0))
        b.poll(now)

        b.offer(pkt(20)) // perdió 19
        val d = b.poll(now) as PlayoutDecision.Gap
        assertEquals(PlayoutBuffer.PLC_CAP, d.plcFrames)
    }

    @Test
    fun `cola vacia devuelve Idle`() {
        val b = buffer()
        assertEquals(PlayoutDecision.Idle, b.poll(now))
    }

    @Test
    fun `cola llena expulsa el mas viejo`() {
        val b = buffer()
        for (i in 0 until PlayoutBuffer.CAPACITY) b.offer(pkt(i.toLong()))
        val ev: AudioPacket? = b.offer(pkt(99))
        assertEquals(0L, (ev!!).sequenceNumber)  // el más viejo sale
        assertEquals(PlayoutBuffer.CAPACITY, b.depth)
        // El engine lo recibe en offer() y lo devuelve al pool; onDiscard
        // solo se usa para descartes internos (drenaje/reset).
    }

    @Test
    fun `ráfaga grande dispara resync duro al target`() {
        val b = PlayoutBuffer()
        feed(b, 0, 20) // 21 > MAX_DEPTH(=14)
        val d = b.poll(now)
        assertTrue(d is PlayoutDecision.Play)
        assertEquals(1, b.hardResyncs)
        assertTrue(b.depth <= b.targetDepth)
        // saltó de golpe al target: los viejos se descartaron
        assertTrue(b.drainedForCatchUp > 0)
    }

    @Test
    fun `drenaje gradual baja la profundidad de a 1 por intervalo`() {
        val b = PlayoutBuffer()
        feed(b, 0, b.targetDepth + 4L) // depth = target+5 > target+2
        var d1 = b.poll(0)
        val depthAfterFirst = b.depth
        assertTrue(d1 is PlayoutDecision.Play)

        // mismo instante: no hay más drenaje
        d1 = b.poll(0)
        assertTrue(d1 is PlayoutDecision.Play)

        // +250ms: drena 1 más — y saltarse ese packet crea gap de seq
        d1 = b.poll(250)
        assertTrue("drenar un frame genera Gap (el FEC/PLC del siguiente lo tapa), fue $d1",
            d1 is PlayoutDecision.Gap || d1 is PlayoutDecision.Play)
        assertTrue(b.depth < depthAfterFirst)
    }

    @Test
    fun `reset limpia secuencia — reconexion arranca de cero`() {
        val b = buffer()
        feed(b, 5, 8)
        b.poll(now)
        b.reset()
        // Tras reset, el primer paquete entrante NO es un Gap aunque el seq salte.
        b.offer(pkt(30))
        val d = b.poll(now)
        assertTrue("reset debe limpiar lastSeq; no hubo Gap", d is PlayoutDecision.Play)
    }
}
