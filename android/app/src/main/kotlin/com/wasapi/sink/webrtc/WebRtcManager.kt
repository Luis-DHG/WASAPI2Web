package com.wasapi.sink.webrtc

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class WebRtcManager(
    private val context: Context,
    private val signallingClient: SignallingClient = SignallingClient()
) {
    private var factory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var remoteAudioTrack: AudioTrack? = null
    private var iceGatheringDeferred: CompletableDeferred<Unit>? = null
    private var watchdogJob: Job? = null

    private var isMuted: Boolean = false
    private var lastPacketTs: Long = 0
    private var lastPacketsReceived: Long = -1

    companion object {
        // ponytail: ganancia 2x sobre default 1.0. AudioTrack.setVolume rango 0-10.
        private const val SCALED_VOLUME = 2.0
    }

    private fun forceSpeakerRoute() {
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (am.mode != AudioManager.MODE_NORMAL) am.mode = AudioManager.MODE_NORMAL
            @Suppress("DEPRECATION")
            if (!am.isSpeakerphoneOn) am.isSpeakerphoneOn = true
        } catch (_: Exception) {}
    }

    var onConnectionStateChange: ((PeerConnection.PeerConnectionState) -> Unit)? = null
    var onIceConnectionStateChange: ((PeerConnection.IceConnectionState) -> Unit)? = null
    var onSilenceDetected: (() -> Unit)? = null

    init {
        initFactory()
    }

    private fun initFactory() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        // ponytail: forzar routing como media (STREAM_MUSIC) en vez de voz (STREAM_VOICE_CALL).
        // Sin esto WebRTC cae a MODE_IN_COMMUNICATION -> audio sale por earpiece, no altavoz.
        val audioAttrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()

        val adm = JavaAudioDeviceModule.builder(context)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setAudioAttributes(audioAttrs)
            // ponytail: 48kHz nativo para match directo con Opus sin resampleo extra en playout
            .setSampleRate(48000)
            // ponytail: recvonly — no hay mic, desactivar todo processing de entrada
            .setUseLowLatency(true)
            .createAudioDeviceModule()

        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setAudioProcessingFactory(null)
            .createPeerConnectionFactory()

        // Belt-and-braces: ADM a veces resetea el route. Fija speakerphone ON al arrancar.
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_NORMAL
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = true
    }

    suspend fun connect(serverUrl: String, scope: CoroutineScope): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                closePeerConnection()

                val pcFactory = factory ?: throw IllegalStateException("PeerConnectionFactory no inicializada")
                val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                    bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                    // ponytail: LAN — continual gathering acelera reconexion tras ICE restart
                    continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
                    iceCandidatePoolSize = 0
                }

                iceGatheringDeferred?.cancel()
                iceGatheringDeferred = CompletableDeferred()

                val observer = object : PeerConnection.Observer {
                    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
                    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                        onIceConnectionStateChange?.invoke(state)
                    }
                    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                        // ponytail: M2 race — verificar isActive para que un callback tardio
                        // de la conexion anterior no complete el deferred de la nueva.
                        if (state == PeerConnection.IceGatheringState.COMPLETE) {
                            iceGatheringDeferred?.takeIf { it.isActive }?.complete(Unit)
                        }
                    }
                    override fun onIceCandidate(candidate: IceCandidate) {}
                    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
                    override fun onAddStream(stream: MediaStream) {}
                    override fun onRemoveStream(stream: MediaStream) {}
                    override fun onDataChannel(dataChannel: DataChannel) {}
                    override fun onRenegotiationNeeded() {}
                    override fun onTrack(transceiver: RtpTransceiver) {
                        val track = transceiver.receiver?.track()
                        if (track is AudioTrack) {
                            remoteAudioTrack = track
                            track.setEnabled(!isMuted)
                            track.setVolume(SCALED_VOLUME)
                            forceSpeakerRoute()
                            lastPacketTs = System.currentTimeMillis()
                        }
                    }
                    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                        onConnectionStateChange?.invoke(newState)
                        if (newState == PeerConnection.PeerConnectionState.CONNECTED) {
                            startWatchdog(scope)
                        } else if (newState == PeerConnection.PeerConnectionState.FAILED ||
                            newState == PeerConnection.PeerConnectionState.CLOSED
                        ) {
                            stopWatchdog()
                        }
                    }
                }

                val pc = pcFactory.createPeerConnection(rtcConfig, observer)
                    ?: throw RuntimeException("No se pudo crear RTCPeerConnection")
                peerConnection = pc

                // Transceiver recvonly para audio
                val transceiverInit = RtpTransceiver.RtpTransceiverInit(
                    RtpTransceiver.RtpTransceiverDirection.RECV_ONLY
                )
                pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, transceiverInit)

                // Crear Offer SDP
                val offer = pc.createOfferAsync()
                pc.setLocalDescriptionAsync(offer)

                // ponytail: LAN host candidates son instant (<50ms), 1s timeout de sobra
                withTimeoutOrNull(1000L) {
                    iceGatheringDeferred?.await()
                }

                val localDesc = pc.localDescription ?: offer
                val answerResult = signallingClient.postOffer(
                    serverUrl = serverUrl,
                    sdp = localDesc.description,
                    type = "offer"
                )

                val (answerSdp, _) = answerResult.getOrThrow()
                val answerDesc = SessionDescription(SessionDescription.Type.ANSWER, answerSdp)
                pc.setRemoteDescriptionAsync(answerDesc)
            }
        }

    fun setMuted(muted: Boolean) {
        isMuted = muted
        remoteAudioTrack?.setEnabled(!muted)
    }

    /**
     * Reafirma el estado de la ruta de audio (track habilitado, volumen, altavoz).
     * ponytail: replicación programática de lo que el desbloqueo hace a mano;
     * se invoca en ACTION_SCREEN_ON y en AUDIOFOCUS_GAIN (bug pantalla apagada).
     */
    fun kickAudio() {
        remoteAudioTrack?.let {
            it.setEnabled(!isMuted)
            it.setVolume(SCALED_VOLUME)
        }
        forceSpeakerRoute()
    }

    private fun startWatchdog(scope: CoroutineScope) {
        stopWatchdog()
        lastPacketsReceived = -1
        lastPacketTs = System.currentTimeMillis()

        watchdogJob = scope.launch(Dispatchers.Default) {
            while (isActive) {
                delay(3000L)
                val currentPc = peerConnection ?: break
                currentPc.getStats { report ->
                    var packetsNow = -1L
                    for (stats in report.statsMap.values) {
                        if (stats.type == "inbound-rtp" && stats.members["kind"] == "audio") {
                            val count = (stats.members["packetsReceived"] as? Number)?.toLong()
                            if (count != null) {
                                packetsNow = count
                                break
                            }
                        }
                    }
                    if (packetsNow >= 0) {
                        if (lastPacketsReceived in 0 until packetsNow) {
                            // ponytail: solo kick en transicion silencio->audio, no cada tick
                            val wasSilent = System.currentTimeMillis() - lastPacketTs > 5000L
                            lastPacketTs = System.currentTimeMillis()
                            if (wasSilent) {
                                forceSpeakerRoute()
                                remoteAudioTrack?.setEnabled(!isMuted)
                            }
                        }
                        lastPacketsReceived = packetsNow
                    }
                    if (lastPacketTs > 0 && System.currentTimeMillis() - lastPacketTs > 10000L) {
                        onSilenceDetected?.invoke()
                    }
                }
            }
        }
    }

    private fun stopWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = null
    }

    fun closePeerConnection() {
        stopWatchdog()
        remoteAudioTrack = null
        try {
            peerConnection?.dispose()
        } catch (_: Exception) {}
        peerConnection = null
    }

    fun dispose() {
        closePeerConnection()
        try {
            factory?.dispose()
        } catch (_: Exception) {}
        factory = null
    }

    private suspend fun PeerConnection.createOfferAsync(
        constraints: MediaConstraints = MediaConstraints()
    ): SessionDescription = suspendCancellableCoroutine { cont ->
        createOffer(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription) {
                if (cont.isActive) cont.resume(desc)
            }
            override fun onSetSuccess() {}
            override fun onCreateFailure(err: String?) {
                if (cont.isActive) cont.resumeWithException(RuntimeException("createOffer fallo: $err"))
            }
            override fun onSetFailure(err: String?) {}
        }, constraints)
    }

    private suspend fun PeerConnection.setLocalDescriptionAsync(
        desc: SessionDescription
    ): Unit = suspendCancellableCoroutine { cont ->
        setLocalDescription(object : SdpObserver {
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onSetSuccess() {
                if (cont.isActive) cont.resume(Unit)
            }
            override fun onCreateFailure(err: String?) {}
            override fun onSetFailure(err: String?) {
                if (cont.isActive) cont.resumeWithException(RuntimeException("setLocalDescription fallo: $err"))
            }
        }, desc)
    }

    private suspend fun PeerConnection.setRemoteDescriptionAsync(
        desc: SessionDescription
    ): Unit = suspendCancellableCoroutine { cont ->
        setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onSetSuccess() {
                if (cont.isActive) cont.resume(Unit)
            }
            override fun onCreateFailure(err: String?) {}
            override fun onSetFailure(err: String?) {
                if (cont.isActive) cont.resumeWithException(RuntimeException("setRemoteDescription fallo: $err"))
            }
        }, desc)
    }
}
