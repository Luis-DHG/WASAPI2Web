/* app.js - PyWebRTCSink cliente WebRTC.
 *
 * Arquitectura:
 *   1. RTCPeerConnection ofrece SDP via fetch POST /offer al backend.
 *   2. <audio autoplay>.srcObject = event.streams[0] → decode Opus HW.
 *   3. navigator.mediaSession registra Foreground Service de media en
 *      Android Chrome para prevenir Doze Mode al apagar pantalla.
 *   4. Listener "pause" en <audio> recupera Audio Focus si el SO pausa.
 *   5. Reconexion automatica si ICE entra en "failed".
 *
 * Sin jitter buffer manual: el stack WebRTC del navegador gestiona
 * jitter, NACK, PLI y reordenado de paquetes.
 */
(function () {
  "use strict";

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
  let watchdogTimer = null;
  let lastPacketTs = 0;            // ultimo timestamp con paquetes RTP recibidos
  let lastPacketsReceived = -1;     // contador anterior para delta

  // ---- Constantes ----
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  const ICE_SERVERS = [];  // vacio = solo host candidates (LAN pura)
  const WATCHDOG_INTERVAL_MS = 3000;   // poll cada 3s
  const WATCHDOG_SILENCE_MS = 10000;   // 10s sin paquetes → reconnect

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
          lastPacketTs = Date.now();
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
        startWatchdog();
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        stopWatchdog();
      }
    };

    pc.addTransceiver("audio", { direction: "recvonly" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, 2000);

    setBadge("señalizando...", "recon");
    let resp;
    try {
      resp = await fetch("/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp: pc.localDescription.sdp,
          type: pc.localDescription.type,
        }),
      });
    } catch (e) {
      log("Fetch /offer fallo:", e);
      setBadge("sin server", "off");
      scheduleReconnect();
      return;
    }

    if (!resp.ok) {
      const err = await resp.text();
      log("/offer HTTP error", resp.status, err);
      setBadge("error server", "off");
      scheduleReconnect();
      return;
    }

    const answer = await resp.json();
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

  // ---- Watchdog: detecta silencio RTP post-Doze y fuerza reconnect ----
  async function startWatchdog() {
    stopWatchdog();
    lastPacketsReceived = -1;
    watchdogTimer = setInterval(async function () {
      if (!pc || !playing) return;
      let packetsNow = -1;
      try {
        const stats = await pc.getStats();
        stats.forEach(function (report) {
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            packetsNow = report.packetsReceived || 0;
          }
        });
      } catch (e) { return; }
      if (packetsNow >= 0) {
        if (packetsNow > lastPacketsReceived && lastPacketsReceived >= 0) {
          // Paquetes nuevos: stream vivo.
          lastPacketTs = Date.now();
        }
        lastPacketsReceived = packetsNow;
      }
      // Si llevamos >WATCHDOG_SILENCE_MS sin paquetes nuevos → reconnect.
      if (lastPacketTs > 0 && Date.now() - lastPacketTs > WATCHDOG_SILENCE_MS) {
        stopWatchdog();
        scheduleReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
  }
  function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  }

  // ---- Reconexion ----
  function scheduleReconnect() {
    if (reconnectTimer) return;
    stopWatchdog();
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
  audioEl.addEventListener("ended", function () {});

  // ---- Lifecycle ----
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && playing) {
      requestWakeLock();
      if (audioEl.paused) audioEl.play().catch(function () {});
      if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
    }
  });
  if ("onfreeze" in document) {
    document.addEventListener("freeze", function () {});
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
      stopWatchdog();
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
      await fetch("/api/pc/media-key", { method: "POST" });
    } catch (e) {
      log("Fallo al enviar tecla multimedia:", e);
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
})();
