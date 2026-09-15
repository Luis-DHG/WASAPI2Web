package com.wasapi.sink.audio.engine

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.wasapi.sink.audio.codec.OpusDecoderWrapper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "RealtimeAudioSink"

enum class EngineState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    ERROR
}

/**
 * Motor integral de audio en tiempo real:
 * - Ingesta binaria WebSocket con parsing Little-Endian.
 * - Pool de DirectByteBuffers preasignados (Zero Allocations en runtime).
 * - Jitter Buffer con compensación adaptativa de ráfagas TCP (Catch-Up).
 * - Renderizado en AudioTrack de baja latencia en hilo de prioridad URGENT_AUDIO.
 */
class RealtimeAudioSinkEngine(
    private val context: Context,
    private val serverWsUrl: String
) {
    companion object {
        const val SAMPLE_RATE = 48000
        const val CHANNELS = 2
        const val SAMPLES_PER_FRAME_PER_CHANNEL = 960 // 20 ms @ 48 kHz
        const val BYTES_PER_SAMPLE = 2 // 16-bit PCM (Int16)
        const val PCM_FRAME_SIZE_BYTES = SAMPLES_PER_FRAME_PER_CHANNEL * CHANNELS * BYTES_PER_SAMPLE // 3840 bytes

        const val HEADER_SIZE_BYTES = 8 // u32 Sequence (4B) + u32 Timestamp (4B)
        const val MAX_OPUS_PAYLOAD_SIZE = 1275 // Max Opus frame size
        const val MAX_PACKET_CAPACITY = HEADER_SIZE_BYTES + MAX_OPUS_PAYLOAD_SIZE

        private const val POOL_CAPACITY = 32
        private const val JITTER_QUEUE_CAPACITY = 16

        // Umbral de ráfagas TCP: Si hay más de 3 frames (60ms) acumulados, se acelera el drenaje
        private const val MAX_JITTER_THRESHOLD_FRAMES = 3

        // ponytail: cap de relleno PLC — >3 frames sintetizados seguidos suena
        // robótico; hueco más grande = salto limpio, no relleno.
        private const val MAX_PLC_FRAMES = 3

        // Diagnóstico background-silence: cada 200 frames (~4s) log de salud
        // del pipeline audio (decode → write → HAL).
        private const val HEALTH_LOG_FRAMES = 200
    }

    // Contadores de salud del pipeline (solo diagnóstico)
    private var hbDecoded = 0L
    private var hbWritten = 0L
    private var hbPlc = 0L
    private var hbFec = 0L
    private var hbIdle = 0L

    data class AudioPacket(
        val buffer: ByteBuffer,
        var sequenceNumber: Long = 0L,
        var payloadSize: Int = 0
    )

    var onStateChange: ((EngineState) -> Unit)? = null

    private val isRunning = AtomicBoolean(false)
    private var isMuted = false
    private var audioThread: Thread? = null

    // ponytail: watchdog de recepción. Un TCP "vivo" que deja de entregar
    // frames (radio dormida, NAT medio-muerto) no lo detecta el ping de
    // OkHttp a tiempo. Sin frames reales en >4s, cancel() dispara
    // onFailure/onClosed → reconnect normal del service.
    @Volatile
    private var lastRxAt = 0L

    // Estructuras Lock-Free / Concurrentes pre-asignadas
    private val packetPool = ArrayBlockingQueue<AudioPacket>(POOL_CAPACITY)
    private val jitterQueue = ArrayBlockingQueue<AudioPacket>(JITTER_QUEUE_CAPACITY)

    private var audioTrack: AudioTrack? = null
    private var opusDecoder: OpusDecoderWrapper? = null
    private var webSocket: WebSocket? = null
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // Keep alive continuo
        // ponytail: ping NAT/OS-keepalive — sin esto el SO puede congelar el
        // socket en background y el badge queda "Conectado" con audio muerto.
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    // Buffers de decodificación directos pre-asignados
    private val pcmOutputBuffer = ByteBuffer.allocateDirect(PCM_FRAME_SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)

    // Métricas y seguimiento de secuencia
    private var lastSequenceNumber = -1L
    private var droppedFramesCount = 0L

    init {
        // Inicializar el Pool de memoria nativa fija (Zero-GC Churn)
        for (i in 0 until POOL_CAPACITY) {
            val directBuffer = ByteBuffer.allocateDirect(MAX_PACKET_CAPACITY).order(ByteOrder.LITTLE_ENDIAN)
            packetPool.offer(AudioPacket(buffer = directBuffer))
        }
    }

    /**
     * Inicializa y configura el AudioTrack con los flags de menor latencia posibles.
     */
    private fun initAudioTrack(): AudioTrack {
        val minBufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_STEREO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE)
                }
            }
            .build()

        val audioFormat = AudioFormat.Builder()
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .build()

        val trackBuilder = AudioTrack.Builder()
            .setAudioAttributes(audioAttributes)
            .setAudioFormat(audioFormat)
            .setBufferSizeInBytes(minBufferSize.coerceAtLeast(PCM_FRAME_SIZE_BYTES * 4))
            .setTransferMode(AudioTrack.MODE_STREAM)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            trackBuilder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
        }

        val track = trackBuilder.build()

        // Reducir el buffer activo en el HAL a 2 frames (40ms) para minimizar latencia
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val targetFrames = SAMPLES_PER_FRAME_PER_CHANNEL * 2
            val setFrames = track.setBufferSizeInFrames(targetFrames)
            Log.i(TAG, "AudioTrack configurado: buffer activo fijado en $setFrames frames (~${setFrames * 1000 / SAMPLE_RATE}ms)")
        }

        return track
    }

    fun setMuted(muted: Boolean) {
        isMuted = muted
        Log.i(TAG, "setMuted($muted) → volumen ${if (muted) 0 else 1}")
        audioTrack?.setVolume(if (muted) 0.0f else 1.0f)
    }

    fun start() {
        if (!isRunning.compareAndSet(false, true)) return

        Log.i(TAG, "Iniciando motor de audio en tiempo real...")
        onStateChange?.invoke(EngineState.CONNECTING)

        try {
            opusDecoder = OpusDecoderWrapper(SAMPLE_RATE, CHANNELS)
            audioTrack = initAudioTrack().apply { play() }
        } catch (e: Exception) {
            Log.e(TAG, "Fallo al inicializar recursos de audio: ${e.message}", e)
            onStateChange?.invoke(EngineState.ERROR)
            isRunning.set(false)
            return
        }

        // Iniciar el hilo de renderizado con prioridad de audio en tiempo real
        audioThread = Thread({ audioPlaybackLoop() }, "RealtimeAudioRenderer").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }

        connectWebSocket()
    }

    /**
     * Resuelve el puerto WS preguntando a /api/config del server (única fuente
     * de verdad; fallback 8090 si el GET falla). Corre en hilo propio para no
     * bloquear al caller.
     */
    private fun resolveWsUrl(serverUrl: String, onResolved: (String) -> Unit) {
        Thread({
            var base = serverUrl.trim().trimEnd('/')
            if (!base.startsWith("http://") && !base.startsWith("https://")) base = "http://$base"
            val wsPort = try {
                val req = Request.Builder().url("$base/api/config").build()
                httpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw java.io.IOException("HTTP ${resp.code}")
                    org.json.JSONObject(resp.body?.string() ?: "").optInt("ws_port", 8090)
                }
            } catch (e: Exception) {
                Log.w(TAG, "No pude leer /api/config (${e.message}); fallback ws_port=8090")
                8090
            }
            // ponytail: del base solo importa el host; el WS cuelga de la raíz.
            val host = base.removePrefix("http://").removePrefix("https://")
                .substringBefore('/').substringBefore(':')
            onResolved("ws://$host:$wsPort")
        }, "ws-url-resolver").start()
    }

    private fun connectWebSocket() {
        resolveWsUrl(serverWsUrl) { wsUrl ->
            if (!isRunning.get()) return@resolveWsUrl
            Log.i(TAG, "Conectando WebSocket a: $wsUrl")

            val request = Request.Builder().url(wsUrl).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket conectado con el backend")
                lastSequenceNumber = -1L
                lastRxAt = SystemClock.elapsedRealtime()
                onStateChange?.invoke(EngineState.CONNECTED)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (!isRunning.get()) return
                lastRxAt = SystemClock.elapsedRealtime()
                val length = bytes.size
                if (length < HEADER_SIZE_BYTES) return

                // Obtener buffer del pool (Zero allocation)
                val packet = packetPool.poll() ?: run {
                    Log.w(TAG, "Pool agotado. Descartando paquete.")
                    return
                }

                val buf = packet.buffer
                buf.clear()

                // Copiar bytes de Okio al DirectBuffer sin instanciar byte[] intermedios
                bytes.asByteBuffer().let { inBuf ->
                    buf.put(inBuf)
                }
                buf.flip()

                // Cabecera binaria Big-Endian (u32BE seq + u32BE ts) — ver opus.rs (to_be_bytes)
                // ponytail: ts no se consume (jitter es FIFO puro); solo seq.
                buf.order(ByteOrder.BIG_ENDIAN)
                val seq = buf.int.toLong() and 0xFFFFFFFFL
                val payloadSize = length - HEADER_SIZE_BYTES

                packet.sequenceNumber = seq
                packet.payloadSize = payloadSize

                // Insertar en la cola del Jitter Buffer
                if (!jitterQueue.offer(packet)) {
                    // Cola llena: descartar el frame más viejo (evita acumulación de latencia)
                    val dropped = jitterQueue.poll()
                    if (dropped != null) {
                        packetPool.offer(dropped)
                        droppedFramesCount++
                    }
                    jitterQueue.offer(packet)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "Error en WebSocket: ${t.message}", t)
                if (isRunning.get()) {
                    onStateChange?.invoke(EngineState.RECONNECTING)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket cerrado: $reason ($code)")
                if (isRunning.get()) {
                    onStateChange?.invoke(EngineState.DISCONNECTED)
                }
            }
            })
        }
    }

    /**
     * Bucle de reproducción en hilo de alta prioridad.
     * Gestiona el Jitter Buffer, descarte adaptativo por ráfagas TCP y decodificación.
     */
    private fun audioPlaybackLoop() {
        // Fijar prioridad del hilo a nivel del kernel de Linux
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)

        Log.i(TAG, "Bucle de reproducción de audio iniciado.")

        while (isRunning.get()) {
            try {
                // Catch-up de ráfagas TCP: descartar de a 1 por tick. El FEC del
                // siguiente frame tapa el hueco (drenar de golpe creaba huecos
                // multi-frame que el FEC no alcanza a cubrir → chasquido).
                if (jitterQueue.size > MAX_JITTER_THRESHOLD_FRAMES) {
                    jitterQueue.poll()?.let {
                        packetPool.offer(it)
                        droppedFramesCount++
                    }
                }

                // Esperar el siguiente paquete (máximo 25ms para evitar bloquear indefinidamente)
                val packet = jitterQueue.poll(25, TimeUnit.MILLISECONDS)
                if (packet == null) {
                    hbIdle++
                    logHealth("idle")
                    val lastRx = lastRxAt
                    if (lastRx > 0L && SystemClock.elapsedRealtime() - lastRx > 4000L) {
                        Log.w(TAG, "Sin frames por >4s con socket abierto. Forzando reconexión.")
                        lastRxAt = 0L
                        webSocket?.cancel()
                    }
                    continue
                }

                // Hueco de secuencia: el FEC inband del paquete actual recupera el
                // frame inmediatamente anterior; los frames perdidos previos se tapan
                // con PLC (Opus sintetiza relleno suavizado en vez de bache de silencio).
                if (lastSequenceNumber != -1L && packet.sequenceNumber > lastSequenceNumber + 1) {
                    val lostCount = packet.sequenceNumber - (lastSequenceNumber + 1)
                    Log.w(TAG, "Pérdida detectada: $lostCount paquetes omitidos (Seq: ${packet.sequenceNumber})")
                    repeat((lostCount - 1).toInt().coerceAtMost(MAX_PLC_FRAMES)) {
                        renderPlcFrame()
                    }
                    renderPacket(packet, decodeFEC = true)
                }
                lastSequenceNumber = packet.sequenceNumber

                renderPacket(packet, decodeFEC = false)

                // Devolver el paquete al pool inmediatamente
                packetPool.offer(packet)

            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.e(TAG, "Excepción en el bucle de audio: ${e.message}", e)
            }
        }

        Log.i(TAG, "Bucle de reproducción de audio finalizado.")
    }

    /**
     * Decodifica un paquete (con FEC si se pide PLC) y lo escribe al AudioTrack.
     * Siempre decodifica aunque este muteado para no desincronizar el estado del decoder Opus.
     */
    private fun renderPacket(packet: AudioPacket, decodeFEC: Boolean) {
        pcmOutputBuffer.clear()

        // Decodificación directa sin asignación de memoria
        val decodedSamples = opusDecoder?.decodeToByteBuffer(
            input = packet.buffer,
            inputOffset = HEADER_SIZE_BYTES,
            inputSize = packet.payloadSize,
            outputByteBuffer = pcmOutputBuffer,
            frameSize = SAMPLES_PER_FRAME_PER_CHANNEL,
            decodeFEC = decodeFEC
        ) ?: -1

        if (decodedSamples > 0) {
            if (decodeFEC) hbFec++ else hbDecoded++
            writePcmBuffer()
            logHealth("packet")
        } else {
            Log.e(TAG, "Error en decodificación Opus: código $decodedSamples")
        }
    }

    /**
     * Sin paquete (drop-tail del server / descarte de la cola local): Opus
     * sintetiza un frame extrapolado que suena suave en vez de un bache.
     */
    private fun renderPlcFrame() {
        pcmOutputBuffer.clear()
        val decoded = opusDecoder?.decodePlc(pcmOutputBuffer, SAMPLES_PER_FRAME_PER_CHANNEL) ?: -1
        if (decoded > 0) {
            hbPlc++
            writePcmBuffer()
            logHealth("plc")
        }
    }

    /**
     * Log de salud cada HEALTH_LOG_FRAMES frames renderizados.
     * Clave para el bug "sin sonido en segundo plano": muestra si los frames
     * llegan (decoded/plc), si se escriben al HAL (written) y si el AudioTrack
     * está avanzando (head) y en qué estado (playState: 1=stopped 2=paused 3=playing).
     */
    private var hbFramesSinceLog = 0
    private fun logHealth(origin: String) {
        if (++hbFramesSinceLog < HEALTH_LOG_FRAMES) return
        hbFramesSinceLog = 0
        val track = audioTrack
        val head = track?.playbackHeadPosition ?: -1
        val playState = track?.playState ?: -1
        val underruns = track?.underrunCount ?: -1
        Log.i(
            TAG,
            "hb[$origin] decoded=$hbDecoded plc=$hbPlc fec=$hbFec idle=$hbIdle written=$hbWritten " +
                "head=$head playState=$playState underruns=$underruns " +
                "muted=$isMuted lastRx=${SystemClock.elapsedRealtime() - lastRxAt}ms"
        )
    }

    private fun writePcmBuffer() {
        if (isMuted) return
        // ponytail: write parcial exige reintentar resto; dropearlo era underrun silencioso.
        audioTrack?.let { track ->
            while (pcmOutputBuffer.hasRemaining()) {
                val bytesWritten = track.write(
                    pcmOutputBuffer,
                    pcmOutputBuffer.remaining(),
                    AudioTrack.WRITE_BLOCKING
                )
                if (bytesWritten < 0) {
                    Log.e(TAG, "Error de escritura en AudioTrack: $bytesWritten")
                    break
                }
                hbWritten += bytesWritten
                if (bytesWritten == 0) break // evita spin si HAL no avanza
            }
        }
    }

    fun stop() {
        if (!isRunning.compareAndSet(true, false)) return

        Log.i(TAG, "Deteniendo motor de audio...")
        onStateChange?.invoke(EngineState.DISCONNECTED)

        webSocket?.close(1000, "App closed")
        webSocket = null

        // ponytail: cada engine trae su propio OkHttpClient; apagarlo o cada reconnect fuga hilos.
        httpClient.dispatcher.executorService.shutdown()
        httpClient.connectionPool.evictAll()

        audioThread?.interrupt()
        try {
            audioThread?.join(500)
        } catch (_: Exception) {}
        audioThread = null

        audioTrack?.apply {
            runCatching { pause() }
            runCatching { flush() }
            runCatching { stop() }
            runCatching { release() }
        }
        audioTrack = null

        opusDecoder?.release()
        opusDecoder = null

        jitterQueue.clear()
        packetPool.clear()
    }
}
