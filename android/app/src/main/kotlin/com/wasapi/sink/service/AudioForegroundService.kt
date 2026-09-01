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
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import androidx.core.content.ContextCompat
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import com.wasapi.sink.MainActivity
import com.wasapi.sink.R
import com.wasapi.sink.webrtc.SignallingClient
import com.wasapi.sink.webrtc.WebRtcManager
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
import org.webrtc.PeerConnection
import kotlin.math.min
import kotlin.math.pow

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    ERROR
}

data class ServiceUiState(
    val connectionState: ConnectionState = ConnectionState.DISCONNECTED,
    val isPlaying: Boolean = false,
    val isMuted: Boolean = false,
    val serverUrl: String = ""
)

class AudioForegroundService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLock: PowerManager.WakeLock? = null
    // ponytail: el PARTIAL_WAKE_LOCK mantiene la CPU pero no la radio Wi-Fi;
    // sin WifiLock los paquetes RTP entrantes se pierden con pantalla apagada.
    private var wifiLock: WifiManager.WifiLock? = null
    private var audioManager: AudioManager? = null

    // ponytail: C (alternativas.md) — al encender pantalla, replicar el kick
    // que el desbloqueo hace a mano sobre track/ruta de audio.
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_ON) {
                webRtcManager?.kickAudio()
            }
        }
    }

    // ponytail: D (alternativas.md) — foco real; hoy el sistema puede mutearnos
    // por robo de foco sin que nos enteremos.
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_GAIN) {
            webRtcManager?.kickAudio()
        }
    }
    private var mediaSession: MediaSessionCompat? = null
    private var webRtcManager: WebRtcManager? = null
    private val signallingClient = SignallingClient()

    private var reconnectJob: Job? = null
    private var reconnectAttempts = 0
    private var currentServerUrl: String = ""

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        setupMediaSession()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        ContextCompat.registerReceiver(
            this, screenReceiver, IntentFilter(Intent.ACTION_SCREEN_ON),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        webRtcManager = WebRtcManager(this, signallingClient).apply {
            onConnectionStateChange = { state ->
                handleConnectionStateChange(state)
            }
            onIceConnectionStateChange = { state ->
                if (state == PeerConnection.IceConnectionState.FAILED) {
                    scheduleReconnect()
                }
            }
            onSilenceDetected = {
                scheduleReconnect()
            }
        }
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
                webRtcManager?.setMuted(newMuted)
            }
            ACTION_SEND_MEDIA_KEY -> {
                serviceScope.launch {
                    signallingClient.sendMediaKey(currentServerUrl)
                }
            }
        }
        return START_STICKY
    }

    private fun startForegroundStreaming(serverUrl: String) {
        acquireWakeLock()
        // ponytail: AUDIOFOCUS_GAIN — foco de media real; sin esto otra app
        // puede mutearnos en background y nunca recuperarlo.
        audioManager?.requestAudioFocus(
            focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN
        )
        val notif = buildNotification("Conectando con $serverUrl...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }

        reconnectAttempts = 0
        _uiState.value = _uiState.value.copy(
            isPlaying = true,
            serverUrl = serverUrl,
            connectionState = ConnectionState.CONNECTING
        )

        connectWebRtc(serverUrl)
    }

    private fun connectWebRtc(serverUrl: String) {
        reconnectJob?.cancel()
        serviceScope.launch {
            webRtcManager?.connect(serverUrl, this)
                ?.onSuccess {
                    reconnectAttempts = 0
                }
                ?.onFailure {
                    _uiState.value =
                        _uiState.value.copy(connectionState = ConnectionState.ERROR)
                    scheduleReconnect()
                }
        }
    }

    private fun handleConnectionStateChange(state: PeerConnection.PeerConnectionState) {
        serviceScope.launch {
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> {
                    reconnectAttempts = 0
                    _uiState.value = _uiState.value.copy(
                        connectionState = ConnectionState.CONNECTED
                    )
                    updateNotification("Conectado: $currentServerUrl")
                }
                PeerConnection.PeerConnectionState.FAILED -> {
                    _uiState.value = _uiState.value.copy(connectionState = ConnectionState.RECONNECTING)
                    scheduleReconnect()
                }
                PeerConnection.PeerConnectionState.DISCONNECTED -> {
                    _uiState.value = _uiState.value.copy(connectionState = ConnectionState.RECONNECTING)
                }
                PeerConnection.PeerConnectionState.CLOSED -> {
                    if (_uiState.value.isPlaying) {
                        _uiState.value = _uiState.value.copy(connectionState = ConnectionState.DISCONNECTED)
                    }
                }
                else -> {}
            }
        }
    }

    private fun scheduleReconnect() {
        if (!_uiState.value.isPlaying) return
        if (reconnectJob?.isActive == true) return

        webRtcManager?.closePeerConnection()
        val delayMs = min(
            (500.0 * 2.0.pow(reconnectAttempts.toDouble())).toLong(),
            5000L
        )
        reconnectAttempts++

        _uiState.value = _uiState.value.copy(connectionState = ConnectionState.RECONNECTING)
        updateNotification("Reconectando (${reconnectAttempts})...")

        reconnectJob = serviceScope.launch {
            delay(delayMs)
            if (isActive && _uiState.value.isPlaying) {
                connectWebRtc(currentServerUrl)
            }
        }
    }

    private fun stopStreaming() {
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempts = 0
        webRtcManager?.closePeerConnection()
        releaseWakeLock()
        audioManager?.abandonAudioFocus(focusListener)

        _uiState.value = _uiState.value.copy(
            isPlaying = false,
            connectionState = ConnectionState.DISCONNECTED
        )
        stopForeground(STOP_FOREGROUND_REMOVE)
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
            // LOW_LATENCY requiere API 29; HIGH_PERF cubre minSdk 24.
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
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(statusText: String): Notification {
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

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(statusText)
            .setContentIntent(pendingOpen)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Detener", pendingStop)
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
        webRtcManager?.dispose()
        webRtcManager = null
        mediaSession?.release()
        mediaSession = null
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
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
