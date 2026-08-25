/* app.js - PyWebRTCSink cliente WebRTC.
 *
 * Arquitectura:
 *   1. RTCPeerConnection ofrece SDP via Signalling.postOffer al backend.
 *   2. <audio autoplay>.srcObject = event.streams[0] -> decode Opus HW.
 *   3. navigator.mediaSession registra Foreground Service de media en
 *      Android Chrome para prevenir Doze Mode al apagar pantalla.
 *   4. Listener "pause" en <audio> recupera Audio Focus si el SO pausa.
 *   5. Reconexion automatica si ICE entra en "failed".
 *   6. RtpSilenceWatchdog (./watchdog.js) fuerza reconnect ante silencio RTP.
 *
 * Sin jitter buffer manual: el stack WebRTC del navegador gestiona
 * jitter, NACK, PLI y reordenado de paquetes.
 */
import { postOffer, postMediaKey } from "./signalling.js";
import { createRtpSilenceWatchdog } from "./watchdog.js";

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const playBtn = $("playBtn");
  const playLabel = $("playLabel");
  const playIcon = $("playIcon");
  const hintCtx = $("hintCtx");
  const wsBadge = $("wsBadge");
  const audioEl = $("outEl");
  const muteBtn = $("muteBtn");
  const muteIcon = $("muteIcon");
  const muteLabel = $("muteLabel");
  const mediaKeyBtn = $("mediaKeyBtn");

  // ---- Estado ----
  let pc = null;
  let playing = false;
  let isMuted = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let wakeLock = null;

  // ---- Constantes ----
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  const ICE_SERVERS = [];  // vacio = solo host candidates (LAN pura)

  // ---- Watchdog ----
  function onSilenceDetected() {
    watchdog.stop();
    scheduleReconnect();
  }
  const watchdog = createRtpSilenceWatchdog({ onSilence: onSilenceDetected });

  // ---- Utilidades ----
  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[PyWebRTCSink]");
    console.log.apply(console, args);
  }
  function setControlsEnabled(enabled) {
    [muteBtn, mediaKeyBtn].forEach(function (b) {
      if (b) b.disabled = !enabled;
    });
  }
  function setBadge(text, cls) {
    wsBadge.textContent = text;
    wsBadge.className = "badge " + (cls || "");
    if (cls === "off") {
      setControlsEnabled(false);
    } else if (cls === "live") {
      setControlsEnabled(true);
    }
  }
  function setPlaying(isPlaying) {
    playing = isPlaying;
    if (isPlaying) {
      playBtn.classList.add("playing");
      playLabel.textContent = "ACTIVO";
      hintCtx.textContent = "Escuchando audio del PC · WebRTC";
      playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
    } else {
      playBtn.classList.remove("playing");
      playLabel.textContent = "ESCUCHAR";
      hintCtx.textContent = "Toca para escuchar el audio del PC";
      playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
  }

  // ---- MediaSession API — clave anti-Doze en Android ----
  // ponytail: browser-specific, no extraer a spec compartida con Android (API difiere).
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "PyWebRTCSink",
        artist: "PC Loopback (WASAPI)",
        album: "WebRTC Stream",
      });
      navigator.mediaSession.setActionHandler("play", function () {
        audioEl.play().catch(function (e) { log("Error en play:", e); });
        if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
      });
      navigator.mediaSession.setActionHandler("pause", function () {});
      navigator.mediaSession.setActionHandler("stop", function () {});
      navigator.mediaSession.playbackState = "playing";
    } catch (e) {
      log("MediaSession fallo:", e);
    }
  }
  function clearMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      try { navigator.mediaSession.setActionHandler("play", null); } catch (e) {}
      try { navigator.mediaSession.setActionHandler("pause", null); } catch (e) {}
      try { navigator.mediaSession.setActionHandler("stop", null); } catch (e) {}
    } catch (e) {}
  }

  // ---- WakeLock (refuerzo) ----
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", function () {
        wakeLock = null;
        if (playing) requestWakeLock();
      });
    } catch (e) {
      log("WakeLock fallo:", e);
    }
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  // ---- Crear RTCPeerConnection + señalizar ----
  async function negotiate() {
    pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      bundlePolicy: "max-bundle",
    });

    // Recepcion de track remoto
    pc.ontrack = function (event) {
      if (event.track.kind === "audio") {
        audioEl.srcObject = event.streams[0];
        event.track.onunmute = function () {
          watchdog.prime();
        };
        audioEl.play().catch(function (e) {
          log("Audio play fallo:", e.name);
        });
      }
    };

    pc.oniceconnectionstatechange = function () {
      if (pc.iceConnectionState === "failed") {
        scheduleReconnect();
      }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed") scheduleReconnect();
      if (pc.connectionState === "connected") {
        setBadge("Conectado", "live");
        log("Conectado al servidor");
        reconnectAttempts = 0;
        watchdog.start(() => pc.getStats(), () => !!(pc && playing));
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        watchdog.stop();
      }
    };

    pc.addTransceiver("audio", { direction: "recvonly" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, 2000);

    setBadge("señalizando...", "recon");
    let answer;
    try {
      answer = await postOffer(pc.localDescription);
    } catch (e) {
      log("Signalling fallo:", e.message);
      setBadge(/HTTP/.test(e.message) ? "error server" : "sin server", "off");
      scheduleReconnect();
      return;
    }

    await pc.setRemoteDescription(answer);
    setBadge("conectando...", "recon");
  }

  function waitForIceGathering(pc, timeoutMs) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === "complete") { resolve(); return; }
      var t = setTimeout(function () {
        resolve();
      }, timeoutMs);
      pc.addEventListener("icegatheringstatechange", function () {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          resolve();
        }
      }, { once: true });
    });
  }

  // ---- Reconexion ----
  function scheduleReconnect() {
    if (reconnectTimer) return;
    watchdog.stop();
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    setBadge("recon en " + Math.round(delay) + "ms", "recon");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (playing) negotiate();
    }, delay);
  }

  // ---- Audio Focus recovery: Android puede pausar el <audio> ----
  audioEl.addEventListener("pause", function () {
    if (playing && audioEl.paused) {
      audioEl.play().catch(function (e) {
        log("Reanudacion post-pause fallo:", e.name);
      });
    }
  });

  // ---- Lifecycle ----
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && playing) {
      requestWakeLock();
      if (audioEl.paused) audioEl.play().catch(function () {});
      if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
    }
  });
  if ("onfreeze" in document) {
    document.addEventListener("resume", function () {
      if (playing) {
        requestWakeLock();
        if (audioEl.paused) audioEl.play().catch(function () {});
        if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
      }
    });
  }

  // ---- Toggle play ----
  async function togglePlay() {
    try { navigator.vibrate(10); } catch (e) {}

    if (playing) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      watchdog.stop();
      if (pc) { try { pc.close(); } catch (e) {} pc = null; }
      releaseWakeLock();
      clearMediaSession();
      if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl.srcObject = null; }
      setPlaying(false);
      setBadge("Desconectado", "off");
      return;
    }

    setPlaying(true);
    setBadge("conectando...", "recon");
    try {
      await negotiate();
      setupMediaSession();
      requestWakeLock();
    } catch (e) {
      log("togglePlay fallo:", e);
      setBadge("error", "off");
    }
  }

  // ---- Controles: Silenciar Móvil y Media Key PC ----
  function updateMuteUi(muted) {
    isMuted = muted;
    audioEl.muted = isMuted;
    if (!muteBtn) return;
    muteBtn.setAttribute("aria-pressed", String(isMuted));
    muteBtn.setAttribute("aria-label", isMuted ? "Activar audio móvil" : "Silenciar audio móvil");
    if (isMuted) {
      muteBtn.classList.add("active-warn");
      muteLabel.textContent = "Silenciado";
      muteIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>';
    } else {
      muteBtn.classList.remove("active-warn");
      muteLabel.textContent = "Silenciar";
      muteIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
    }
  }

  function toggleMute() {
    try { navigator.vibrate(10); } catch (e) {}
    updateMuteUi(!isMuted);
  }

  async function sendMediaKey() {
    if (!mediaKeyBtn || mediaKeyBtn.disabled) return;
    try { navigator.vibrate([10, 30, 10]); } catch (e) {}
    mediaKeyBtn.disabled = true;
    mediaKeyBtn.setAttribute("aria-busy", "true");
    mediaKeyBtn.classList.add("pulse-amber");
    try {
      await postMediaKey();
    } catch (e) {
      log("Fallo al enviar tecla multimedia:", e.message);
    } finally {
      setTimeout(() => {
        mediaKeyBtn.classList.remove("pulse-amber");
        mediaKeyBtn.disabled = false;
        mediaKeyBtn.setAttribute("aria-busy", "false");
      }, 220);
    }
  }

  if (muteBtn) muteBtn.addEventListener("click", toggleMute);
  if (mediaKeyBtn) mediaKeyBtn.addEventListener("click", sendMediaKey);

  // Estado inicial de controles (deshabilitados hasta conexion)
  setControlsEnabled(false);

  playBtn.addEventListener("click", togglePlay);

  // Debug hook
  window.PyWebRTCSink = {
    get pc() { return pc; },
    get playing() { return playing; },
    get isMuted() { return isMuted; },
    toggleMute,
    sendMediaKey,
  };
