package com.wasapi.sink.audio.engine

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Process
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
    }

    data class AudioPacket(
        val buffer: ByteBuffer,
        var sequenceNumber: Long = 0L,
        var timestamp: Long = 0L,
        var payloadSize: Int = 0
    )

    var onStateChange: ((EngineState) -> Unit)? = null
    var onMetricsUpdate: ((underruns: Int, droppedFrames: Long) -> Unit)? = null

    private val isRunning = AtomicBoolean(false)
    private var isMuted = false
    private var audioThread: Thread? = null

    // Estructuras Lock-Free / Concurrentes pre-asignadas
    private val packetPool = ArrayBlockingQueue<AudioPacket>(POOL_CAPACITY)
    private val jitterQueue = ArrayBlockingQueue<AudioPacket>(JITTER_QUEUE_CAPACITY)

    private var audioTrack: AudioTrack? = null
    private var opusDecoder: OpusDecoderWrapper? = null
    private var webSocket: WebSocket? = null
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // Keep alive continuo
        .build()

    // Buffers de decodificación directos pre-asignados
    private val pcmOutputBuffer = ByteBuffer.allocateDirect(PCM_FRAME_SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)

    // Métricas y seguimiento de secuencia
    private var lastSequenceNumber = -1L
    private var droppedFramesCount = 0L
    private var lastMetricsReportTs = 0L

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            audioTrack?.setVolume(if (muted) 0.0f else 1.0f)
        }
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

    private fun formatWsUrl(url: String): String {
        // ponytail: el motor Rust publica SIEMPRE en ws://<host>:8090 (raíz, sin path).
        // La URL guardada apunta al HTTP 8080 (UI + media-key); acá extraemos solo el host.
        var host = url.trim()
            .removePrefix("http://").removePrefix("https://")
            .removePrefix("ws://").removePrefix("wss://")
        val slash = host.indexOf('/')
        if (slash >= 0) host = host.substring(0, slash)
        val colon = host.indexOf(':')
        if (colon >= 0) host = host.substring(0, colon)
        return "ws://$host:8090"
    }

    private fun connectWebSocket() {
        val wsUrl = formatWsUrl(serverWsUrl)
        Log.i(TAG, "Conectando WebSocket a: $wsUrl")

        val request = Request.Builder().url(wsUrl).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket conectado con el backend")
                lastSequenceNumber = -1L
                onStateChange?.invoke(EngineState.CONNECTED)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (!isRunning.get()) return
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
                buf.order(ByteOrder.BIG_ENDIAN)
                val seq = buf.int.toLong() and 0xFFFFFFFFL
                val ts = buf.int.toLong() and 0xFFFFFFFFL
                val payloadSize = length - HEADER_SIZE_BYTES

                packet.sequenceNumber = seq
                packet.timestamp = ts
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
                // Monitoreo de acumulación de ráfagas TCP (Catch-Up Policy)
                val queueSize = jitterQueue.size
                if (queueSize > MAX_JITTER_THRESHOLD_FRAMES) {
                    // Drenar ráfagas para recuperar latencia mínima (Head-of-Line Recovery)
                    val dropCount = queueSize - 1
                    for (i in 0 until dropCount) {
                        val dropped = jitterQueue.poll() ?: break
                        packetPool.offer(dropped)
                        droppedFramesCount++
                    }
                    Log.w(TAG, "Ráfaga TCP detectada ($queueSize frames). Drenados $dropCount frames para recuperar latencia.")
                }

                // Esperar el siguiente paquete (máximo 25ms para evitar bloquear indefinidamente)
                val packet = jitterQueue.poll(25, TimeUnit.MILLISECONDS) ?: continue

                // Detección de pérdidas de paquetes
                if (lastSequenceNumber != -1L && packet.sequenceNumber > lastSequenceNumber + 1) {
                    val lostCount = packet.sequenceNumber - (lastSequenceNumber + 1)
                    Log.w(TAG, "Pérdida detectada: $lostCount paquetes omitidos (Seq: ${packet.sequenceNumber})")
                }
                lastSequenceNumber = packet.sequenceNumber

                pcmOutputBuffer.clear()

                // Decodificación directa sin asignación de memoria
                val decodedSamples = opusDecoder?.decodeToByteBuffer(
                    input = packet.buffer,
                    inputOffset = HEADER_SIZE_BYTES,
                    inputSize = packet.payloadSize,
                    outputByteBuffer = pcmOutputBuffer,
                    frameSize = SAMPLES_PER_FRAME_PER_CHANNEL
                ) ?: -1

                // Devolver el paquete al pool inmediatamente
                packetPool.offer(packet)

                if (decodedSamples > 0) {
                    if (!isMuted) {
                        // Renderizado en AudioTrack
                        audioTrack?.let { track ->
                            val bytesWritten = track.write(
                                pcmOutputBuffer,
                                pcmOutputBuffer.remaining(),
                                AudioTrack.WRITE_BLOCKING
                            )

                            if (bytesWritten < 0) {
                                Log.e(TAG, "Error de escritura en AudioTrack: $bytesWritten")
                            }
                        }
                    }
                } else {
                    Log.e(TAG, "Error en decodificación Opus: código $decodedSamples")
                }

                // Reporte periódico de métricas (cada 5 segundos)
                val now = System.currentTimeMillis()
                if (now - lastMetricsReportTs > 5000L) {
                    lastMetricsReportTs = now
                    val underruns = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        audioTrack?.underrunCount ?: 0
                    } else 0
                    onMetricsUpdate?.invoke(underruns, droppedFramesCount)
                }

            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.e(TAG, "Excepción en el bucle de audio: ${e.message}", e)
            }
        }

        Log.i(TAG, "Bucle de reproducción de audio finalizado.")
    }

    fun stop() {
        if (!isRunning.compareAndSet(true, false)) return

        Log.i(TAG, "Deteniendo motor de audio...")
        onStateChange?.invoke(EngineState.DISCONNECTED)

        webSocket?.close(1000, "App closed")
        webSocket = null

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
