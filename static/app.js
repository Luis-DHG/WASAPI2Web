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

  // ---- Estado ----
  let pc = null;
  let playing = false;
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
  function setBadge(text, cls) {
    wsBadge.textContent = text;
    wsBadge.className = "badge " + (cls || "");
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
        log("MediaSession: play handler");
        audioEl.play().catch(function (e) { log("play handler err:", e); });
        if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
      });
      navigator.mediaSession.setActionHandler("pause", function () {
        log("MediaSession: pause handler");
      });
      navigator.mediaSession.setActionHandler("stop", function () {
        log("MediaSession: stop handler");
      });
      navigator.mediaSession.playbackState = "playing";
      log("MediaSession configurada. playbackState=playing");
    } catch (e) {
      log("MediaSession setup fallo:", e);
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
      log("WakeLock (screen) activo");
      wakeLock.addEventListener("release", function () {
        log("WakeLock revocado por SO");
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
      log("Track remoto recibido:", event.track.kind);
      if (event.track.kind === "audio") {
        audioEl.srcObject = event.streams[0];
        // Marcar timestamp primer unmute (stream vivo).
        event.track.onunmute = function () {
          lastPacketTs = Date.now();
          log("Track unmute — stream vivo");
        };
        // Intentar playback inmediatamente (autoplay puede requerir gesto).
        audioEl.play().then(function () {
          log("<audio> play OK");
        }).catch(function (e) {
          log("<audio> play fallo (esperando gesto):", e.name);
        });
      }
    };

    // Estado ICE para diagnostico
    pc.oniceconnectionstatechange = function () {
      log("ICE state:", pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") {
        log("ICE failed → reconectar");
        scheduleReconnect();
      }
    };
    pc.onconnectionstatechange = function () {
      log("PC state:", pc.connectionState);
      if (pc.connectionState === "failed") scheduleReconnect();
      if (pc.connectionState === "connected") {
        setBadge("Conectado", "live");
        reconnectAttempts = 0;
        startWatchdog();
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        stopWatchdog();
      }
    };

    // Solo receive-only: addTransceiver audio recvonly para que el
    // server sepa que queremos su track.
    pc.addTransceiver("audio", { direction: "recvonly" });

    // Crear offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log("SDP Offer creado. Esperando ICE gather...");

    // Esperar a que ICE gathering termine (host candidates en LAN
    // deberian ser instantaneos).
    await waitForIceGathering(pc, 2000);

    // Enviar offer al backend
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
      log("fetch /offer fallo:", e);
      setBadge("sin server", "off");
      scheduleReconnect();
      return;
    }

    if (!resp.ok) {
      const err = await resp.text();
      log("/offer HTTP", resp.status, err);
      setBadge("error server", "off");
      scheduleReconnect();
      return;
    }

    const answer = await resp.json();
    log("SDP Answer recibido");
    await pc.setRemoteDescription(answer);
    log("SDP Answer aplicado. Esperando ICE connectivity...");
    setBadge("conectando...", "recon");
  }

  function waitForIceGathering(pc, timeoutMs) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === "complete") { resolve(); return; }
      var t = setTimeout(function () {
        log("ICE gather timeout, continuando con partial candidates");
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
        log("Watchdog: sin paquetes RTP en", WATCHDOG_SILENCE_MS, "ms → reconnect");
        stopWatchdog();
        scheduleReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
    log("Watchdog iniciado (interval=" + WATCHDOG_INTERVAL_MS +
        "ms, silence=" + WATCHDOG_SILENCE_MS + "ms)");
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
    log("Reconnect en", delay, "ms (intento " + reconnectAttempts + ")");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (playing) negotiate();
    }, delay);
  }

  // ---- Audio Focus recovery: Android puede pausar el <audio> ----
  audioEl.addEventListener("pause", function () {
    // Si estabamos playing y el SO pauso (no el usuario), reanudar.
    if (playing && audioEl.paused) {
      log("<audio> pause evento → intentar reanudar");
      audioEl.play().catch(function (e) {
        log("reanudacion post-pause fallo:", e.name);
      });
    }
  });
  audioEl.addEventListener("ended", function () {
    log("<audio> ended evento");
  });

  // ---- Lifecycle ----
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && playing) {
      log("visibilitychange → visible");
      requestWakeLock();
      if (audioEl.paused) {
        audioEl.play().catch(function () {});
      }
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = "playing";
      }
    }
  });
  if ("onfreeze" in document) {
    document.addEventListener("freeze", function () {
      log("Lifecycle freeze");
    });
    document.addEventListener("resume", function () {
      log("Lifecycle resume");
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
      // STOP
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      stopWatchdog();
      if (pc) { try { pc.close(); } catch (e) {} pc = null; }
      releaseWakeLock();
      clearMediaSession();
      if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl.srcObject = null; }
      setPlaying(false);
      setBadge("Desconectado", "off");
      log("Reproduccion detenida.");
      return;
    }

    // START
    log("Boton INICIAR presionado.");
    setPlaying(true);
    setBadge("conectando...", "recon");
    try {
      await negotiate();
      setupMediaSession();
      requestWakeLock();
      log("Reproduccion iniciada.");
    } catch (e) {
      log("togglePlay fallo:", e);
      setBadge("error", "off");
    }
  }

  playBtn.addEventListener("click", togglePlay);

  // Debug hook
  window.PyWebRTCSink = {
    get pc() { return pc; },
    get playing() { return playing; },
  };
  log("PyWebRTCSink cliente listo (WebRTC + MediaSession).");
})();
