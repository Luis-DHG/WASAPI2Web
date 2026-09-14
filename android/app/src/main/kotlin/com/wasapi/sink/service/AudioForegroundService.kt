package com.wasapi.sink.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.session.MediaSessionCompat
import android.util.Log
import android.widget.Toast
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.wasapi.sink.MainActivity
import com.wasapi.sink.R
import com.wasapi.sink.audio.engine.EngineState
import com.wasapi.sink.audio.engine.RealtimeAudioSinkEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

data class ServiceUiState(
    val connectionState: EngineState = EngineState.DISCONNECTED,
    val isPlaying: Boolean = false,
    val isMuted: Boolean = false
)

class AudioForegroundService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null

    private var mediaSession: MediaSessionCompat? = null
    private var audioSinkEngine: RealtimeAudioSinkEngine? = null
    private val mediaKeyHttp = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).build()

    private var reconnectJob: Job? = null
    private var reconnectAttempts = 0
    private var currentServerUrl: String = ""
    private var lastStatusText: String = ""

    // ponytail: el volumen se escribe por UN solo funnel. El bug "silencio
    // tras background" era volumen clavado en 0 sin GAIN de vuelta; ahora
    // duck es estado explícito y cualquier reconnect/screen-on re-aplica el
    // volumen efectivo completo.
    private var focusDucked = false

    private fun applyVolume(reason: String) {
        val effectiveMuted = _uiState.value.isMuted || focusDucked
        Log.i(TAG, "applyVolume($reason): muted=$effectiveMuted (usuario=${_uiState.value.isMuted}, duck=$focusDucked)")
        audioSinkEngine?.setMuted(effectiveMuted)
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_ON) {
                applyVolume("screen_on")
            }
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                Log.i(TAG, "Audio focus GAIN (duck previo: $focusDucked)")
                focusDucked = false
                applyVolume("focus_gain")
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                Log.i(TAG, "Audio focus LOSS permanente. Deteniendo stream.")
                focusDucked = false
                stopStreaming()
                stopSelf()
            }
            else -> {
                // LOSS_TRANSIENT / LOSS_TRANSIENT_CAN_DUCK: duck temporal;
                // el WS sigue vivo. GAIN restaura vía el mismo funnel.
                Log.i(TAG, "Audio focus transitorio ($change). Duck ON.")
                focusDucked = true
                applyVolume("focus_transient")
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        setupMediaSession()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager

        ContextCompat.registerReceiver(
            this,
            screenReceiver,
            IntentFilter(Intent.ACTION_SCREEN_ON),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        when (action) {
            ACTION_START -> {
                val url = intent?.getStringExtra(EXTRA_SERVER_URL) ?: currentServerUrl
                if (url.isNotBlank()) {
                    currentServerUrl = url
                    startForegroundStreaming(url)
                }
            }
            ACTION_STOP -> {
                stopStreaming()
                stopSelf()
            }
            ACTION_TOGGLE_MUTE -> {
                val newMuted = !_uiState.value.isMuted
                _uiState.value = _uiState.value.copy(isMuted = newMuted)
                applyVolume("toggle_mute")
                updateNotification(lastStatusText)
            }
            ACTION_SEND_MEDIA_KEY -> {
                serviceScope.launch {
                    val result = postMediaKey(currentServerUrl)
                    if (result.isFailure) {
                        Log.w(TAG, "media-key falló: ${result.exceptionOrNull()?.message}")
                        Toast.makeText(
                            this@AudioForegroundService,
                            "No llegó el Play/Pause al PC",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                }
            }
        }
        return START_STICKY
    }

    private fun startForegroundStreaming(serverUrl: String) {
        acquireWakeLock()
        requestAudioFocus()

        val notif = buildNotification("Conectando con $serverUrl...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }

        reconnectAttempts = 0
        _uiState.value = _uiState.value.copy(
            isPlaying = true,
            connectionState = EngineState.CONNECTING
        )

        connectEngine(serverUrl)
    }

    private fun connectEngine(serverUrl: String) {
        reconnectJob?.cancel()
        stopEngine()

        val engine = RealtimeAudioSinkEngine(this, serverUrl).apply {
            onStateChange = { engineState ->
                handleEngineStateChange(engineState)
            }
        }

        audioSinkEngine = engine
        applyVolume("engine_start")
        engine.start()
    }

    private fun handleEngineStateChange(engineState: EngineState) {
        Log.i(TAG, "Engine state: $engineState")
        serviceScope.launch {
            val connState = when (engineState) {
                EngineState.CONNECTED -> {
                    reconnectAttempts = 0
                    updateNotification("Conectado: $currentServerUrl")
                    EngineState.CONNECTED
                }
                EngineState.CONNECTING -> EngineState.CONNECTING
                EngineState.RECONNECTING -> {
                    scheduleReconnect()
                    EngineState.RECONNECTING
                }
                EngineState.ERROR -> {
                    scheduleReconnect()
                    EngineState.ERROR
                }
                EngineState.DISCONNECTED -> {
                    if (_uiState.value.isPlaying) {
                        scheduleReconnect()
                        EngineState.RECONNECTING
                    } else {
                        EngineState.DISCONNECTED
                    }
                }
            }

            _uiState.value = _uiState.value.copy(connectionState = connState)
        }
    }

    private fun scheduleReconnect() {
        if (!_uiState.value.isPlaying) return
        if (reconnectJob?.isActive == true) return

        val delayMs = min(
            (500.0 * 2.0.pow(reconnectAttempts.toDouble())).toLong(),
            5000L
        )
        reconnectAttempts++

        _uiState.value = _uiState.value.copy(connectionState = EngineState.RECONNECTING)
        updateNotification("Reconectando (${reconnectAttempts})...")

        reconnectJob = serviceScope.launch {
            delay(delayMs)
            if (isActive && _uiState.value.isPlaying) {
                connectEngine(currentServerUrl)
            }
        }
    }

    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val playbackAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build()

            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(playbackAttributes)
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(focusListener)
                .build()

            focusRequest = req
            audioManager?.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager?.abandonAudioFocus(focusListener)
        }
    }

    private fun stopStreaming() {
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempts = 0
        stopEngine()
        releaseWakeLock()
        abandonAudioFocus()

        _uiState.value = _uiState.value.copy(
            isPlaying = false,
            connectionState = EngineState.DISCONNECTED
        )
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    // ponytail: engine.stop() hace join+release (bloquea); fuera del Main o es jank/ANR.
    private fun stopEngine() {
        val engine = audioSinkEngine
        audioSinkEngine = null
        if (engine != null) {
            serviceScope.launch(Dispatchers.IO) {
                engine.stop()
            }
        }
    }

    // ponytail: un POST; sin clase aparte. OkHttp ya vive en el classpath por el engine.
    private suspend fun postMediaKey(serverUrl: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${serverUrl.trimEnd('/')}/api/pc/media-key")
                    .post("{}".toRequestBody("application/json; charset=utf-8".toMediaType()))
                    .build()
                mediaKeyHttp.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
                }
            }
        }

    private fun setupMediaSession() {
        mediaSession = MediaSessionCompat(this, "WasapiAudioSession").apply {
            setPlaybackState(
                PlaybackStateCompat.Builder()
                    .setState(PlaybackStateCompat.STATE_PLAYING, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                    .setActions(PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_STOP)
                    .build()
            )
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onStop() { /* no-op: evita kill por Bluetooth/lockscreen */ }
                override fun onPause() { /* no-op */ }
            })
            isActive = true
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wasapi:sink_wakelock").apply {
                setReferenceCounted(false)
            }
        }
        if (wakeLock?.isHeld == false) {
            wakeLock?.acquire(24 * 60 * 60 * 1000L) // 24 horas max
        }

        if (wifiLock == null) {
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else
                @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(mode, "wasapi:wifi").apply {
                setReferenceCounted(false)
            }
        }
        if (wifiLock?.isHeld == false) {
            try {
                wifiLock?.acquire()
            } catch (_: Exception) {}
        }
    }

    private fun releaseWakeLock() {
        if (wakeLock?.isHeld == true) {
            try {
                wakeLock?.release()
            } catch (_: Exception) {}
        }
        if (wifiLock?.isHeld == true) {
            try {
                wifiLock?.release()
            } catch (_: Exception) {}
            wifiLock = null
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.notification_channel_desc)
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(statusText: String): Notification {
        lastStatusText = statusText
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingOpen = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, AudioForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val pendingStop = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val muteIntent = Intent(this, AudioForegroundService::class.java).apply {
            action = ACTION_TOGGLE_MUTE
        }
        val pendingMute = PendingIntent.getService(
            this, 2, muteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val muted = _uiState.value.isMuted

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(statusText)
            .setContentIntent(pendingOpen)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Detener", pendingStop)
            .addAction(
                android.R.drawable.ic_lock_silent_mode,
                if (muted) "Activar sonido" else "Silenciar",
                pendingMute
            )
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(statusText: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(NOTIFICATION_ID, buildNotification(statusText))
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(screenReceiver) }
        stopStreaming()
        mediaSession?.release()
        mediaSession = null
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "AudioFgService"
        const val CHANNEL_ID = "wasapi_audio_playback"
        const val NOTIFICATION_ID = 1001

        const val ACTION_START = "com.wasapi.sink.action.START"
        const val ACTION_STOP = "com.wasapi.sink.action.STOP"
        const val ACTION_TOGGLE_MUTE = "com.wasapi.sink.action.TOGGLE_MUTE"
        const val ACTION_SEND_MEDIA_KEY = "com.wasapi.sink.action.SEND_MEDIA_KEY"

        const val EXTRA_SERVER_URL = "extra_server_url"

        private val _uiState = MutableStateFlow(ServiceUiState())
        val uiState: StateFlow<ServiceUiState> = _uiState.asStateFlow()

        fun start(context: Context, serverUrl: String) {
            val intent = Intent(context, AudioForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_SERVER_URL, serverUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, AudioForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }

        fun toggleMute(context: Context) {
            val intent = Intent(context, AudioForegroundService::class.java).apply {
                action = ACTION_TOGGLE_MUTE
            }
            context.startService(intent)
        }

        fun sendMediaKey(context: Context) {
            val intent = Intent(context, AudioForegroundService::class.java).apply {
                action = ACTION_SEND_MEDIA_KEY
            }
            context.startService(intent)
        }
    }
}
