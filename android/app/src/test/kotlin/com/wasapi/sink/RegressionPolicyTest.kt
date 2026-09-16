package com.wasapi.sink

import com.wasapi.sink.audio.engine.RealtimeAudioSinkEngine
import com.wasapi.sink.audio.engine.TrackFallbackTracker
import com.wasapi.sink.audio.engine.wsUrlFor
import com.wasapi.sink.service.selectServerUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RegressionPolicyTest {

    @Test
    fun `tres stalls en 60 segundos activan fallback hasta reset`() {
        val tracker = TrackFallbackTracker()

        assertFalse(tracker.recordStall(0))
        assertFalse(tracker.recordStall(30_000))
        assertTrue(tracker.recordStall(60_000))
        assertTrue(tracker.fallbackActive)

        tracker.reset()
        assertFalse(tracker.fallbackActive)
    }

    @Test
    fun `stalls separados no activan fallback`() {
        val tracker = TrackFallbackTracker()

        assertFalse(tracker.recordStall(0))
        assertFalse(tracker.recordStall(60_001))
        assertFalse(tracker.recordStall(120_002))
    }

    @Test
    fun `limites del frame websocket protegen el pool`() {
        assertFalse(RealtimeAudioSinkEngine.isPacketLengthValid(7))
        assertTrue(RealtimeAudioSinkEngine.isPacketLengthValid(8))
        assertTrue(RealtimeAudioSinkEngine.isPacketLengthValid(1_283))
        assertFalse(RealtimeAudioSinkEngine.isPacketLengthValid(1_284))
    }

    @Test
    fun `url websocket siempre usa el puerto fijo del Sink`() {
        assertEquals("ws://192.168.1.42:8090", wsUrlFor("192.168.1.42"))
        assertEquals("ws://192.168.1.42:8090", wsUrlFor("http://192.168.1.42:8080/"))
    }

    @Test
    fun `reinicio sticky recupera url guardada y respeta precedencia`() {
        assertEquals("http://nueva", selectServerUrl(" http://nueva ", "http://actual", "http://guardada"))
        assertEquals("http://actual", selectServerUrl(null, "http://actual", "http://guardada"))
        assertEquals("http://guardada", selectServerUrl(null, "", " http://guardada "))
        assertNull(selectServerUrl(null, " ", null))
    }
}
