/* app.js - PyAudioBridge cliente movil (Fase 3: Main Thread ligero).
 *
 * Arquitectura:
 *   - WebSocket + decode + jitter viven en static/audio_worker.js.
 *   - Main Thread solo: AudioContext + MediaStreamAudioDestinationNode
 *     + elemento <audio> oculto + Navigator.mediaSession.
 *   - Estrategia anti-Doze: el <audio> con MediaStream activo hace que
 *     Android Chrome trate el tab como media playback (Foreground Service
 *     equivalente). El AudioContext ya no es el source del sonido desde
 *     el punto de vista OS; el MediaStream del <audio> si.
 *
 * Features:
 *   1. Boton central arranca AudioContext + <audio>.play() + MediaSession.
 *   2. Worker gestiona WS, decode Int16->Float32, jitter, ping/pong RTT.
 *   3. Comunicacion Worker <-> Main via postMessage con Transferable
 *      (Float32Array.buffer), zero-copy.
 *   4. EQ 3 bandas (BiquadFilterNode) entre BufferSource y MediaStreamDest.
 *   5. Reconexion automatica con backoff exponencial.
 *   6. WakeLock("screen") como refuerzo (no principal).
 */
(function () {
  "use strict";

  // ---- Config defaults + persistencia ----
  const SETTINGS_KEY = "pyab_settings_v2";
  const DEFAULT_SETTINGS = {
    latency: 120,        // ms objetivo de jitter buffer playback
    mono: false,
    rate: 0,             // 0 = nativo del dispositivo
    skip: true,
    eqLow: 0, eqMid: 0, eqHigh: 0,
    autoReconnect: true,
  };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return Object.assign({}, DEFAULT_SETTINGS, s);
    } catch (e) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  let settings = loadSettings();

  // ---- Constantes ----
  const MIN_GAP_MS = 20;
  const MAX_LATENCY_MS = 500;
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 8000;
  const SOURCE_POOL_SIZE = 8;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const playBtn = $("playBtn");
  const playLabel = $("playLabel");
  const playIconSvg = $("playIconSvg");
  const hintCtx = $("hintCtx");
  const wsBadge = $("wsBadge");
  const stState = $("stState");
  const stBuffer = $("stBuffer");
  const stUnderrun = $("stUnderrun");
  const stRtt = $("stRtt");
  const stJitter = $("stJitter");
  const stLoss = $("stLoss");
  const stCodec = $("stCodec");
  const stFmt = $("stFmt");
  const stDevice = $("stDevice");
  const latencySlider = $("latencySlider");
  const latencyLbl = $("latencyLbl");
  const codecSel = $("codecSel");
  const monoChk = $("monoChk");
  const skipChk = $("skipChk");
  const eqLow = $("eqLow");
  const eqMid = $("eqMid");
  const eqHigh = $("eqHigh");
  const eqLowLbl = $("eqLowLbl");
  const eqMidLbl = $("eqMidLbl");
  const eqHighLbl = $("eqHighLbl");
  const reconnectChk = $("reconnectChk");
  const settingsBtn = $("settingsBtn");
  const settingsClose = $("settingsClose");
  const settingsBackdrop = $("settingsBackdrop");
  const settingsPanel = $("settingsPanel");
  const statsBtn = $("statsBtn");
  const statsClose = $("statsClose");
  const statsBackdrop = $("statsBackdrop");
  const statsPanel = $("statsPanel");
  const eqToggle = $("eqToggle");
  const eqBody = $("eqBody");
  const audioEl = $("outEl");           // <audio hidden> clave anti-Doze

  // ---- Estado ----
  let audioCtx = null;
  let mediaDest = null;                 // MediaStreamAudioDestinationNode
  let gainNode = null;
  let eqLowNode = null, eqMidNode = null, eqHighNode = null;
  let worker = null;
  let playing = false;
  let connected = false;
  let nextPlayTime = 0;
  let underruns = 0;
  let blockDurMs = 0;
  let blockDurMsPrev = 0;
  let fmt = { rate: 48000, channels: 2, sw: 2, codec: 0, hdrBytes: 8 };
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let wakeLock = null;
  let deviceName = "?";
  let blocksLost = 0;
  let jitterP95 = 0;
  let jitterSamples = [];
  let lastTsMs = 0;
  let statsUpdater = null;

  // ---- Pool de AudioBufferSourceNode (-40% GC en Android) ----
  const sources = [];
  let poolIdx = 0;
  function getFreeSource() {
    if (audioCtx == null) return null;
    const existing = sources[poolIdx % SOURCE_POOL_SIZE];
    if (existing) {
      try { existing.stop(0); } catch (e) {}
      try { existing.disconnect(); } catch (e) {}
    }
    const s = audioCtx.createBufferSource();
    sources[poolIdx % SOURCE_POOL_SIZE] = s;
    poolIdx++;
    return s;
  }

  // ---- Utilidades UI ----
  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[PyAB]");
    console.log.apply(console, args);
  }
  function setWsBadge(text, cls) {
    wsBadge.textContent = text;
    wsBadge.className = "badge " + (cls || "");
  }
  function setState(v, ok) {
    stState.textContent = v;
    stState.className = "v " + (ok ? "ok" : "bad");
  }
  function setPlaying(isPlaying) {
    playing = isPlaying;
    if (isPlaying) {
      playBtn.classList.add("playing");
      playLabel.textContent = "ACTIVO";
      if (hintCtx) hintCtx.textContent = "Escuchando el audio del PC";
      if (playIconSvg) {
        playIconSvg.innerHTML = '<rect x="6" y="5" width="4" height="14" fill="currentColor" stroke="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor" stroke="currentColor"/>';
      }
    } else {
      playBtn.classList.remove("playing");
      playLabel.textContent = "ESCUCHAR";
      if (hintCtx) hintCtx.textContent = "Toca para escuchar el audio del PC";
      if (playIconSvg) {
        playIconSvg.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor" stroke="currentColor"/>';
      }
    }
  }

  // ---- Audio graph: source -> eqLow -> eqMid -> eqHigh -> gain -> mediaDest ----
  function buildAudioGraph() {
    if (audioCtx == null) return;

    eqLowNode = audioCtx.createBiquadFilter();
    eqLowNode.type = "lowshelf";
    eqLowNode.frequency.value = 250;
    eqLowNode.gain.value = settings.eqLow;

    eqMidNode = audioCtx.createBiquadFilter();
    eqMidNode.type = "peaking";
    eqMidNode.frequency.value = 1500;
    eqMidNode.Q.value = 0.7;
    eqMidNode.gain.value = settings.eqMid;

    eqHighNode = audioCtx.createBiquadFilter();
    eqHighNode.type = "highshelf";
    eqHighNode.frequency.value = 4000;
    eqHighNode.gain.value = settings.eqHigh;

    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;

    // MediaStream destination -> <audio>.srcObject. Clave anti-Doze:
    // el <audio> con MediaStream activo hace que Android trate el tab
    // como media playback real (Foreground Service).
    mediaDest = audioCtx.createMediaStreamAudioDestinationNode();

    eqLowNode.connect(eqMidNode);
    eqMidNode.connect(eqHighNode);
    eqHighNode.connect(gainNode);
    gainNode.connect(mediaDest);

    if (audioEl) {
      audioEl.srcObject = mediaDest.stream;
    }
  }

  // ---- Media Session API: notificacion media + Foreground Service ----
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "PyAudioBridge",
        artist: deviceName !== "?" ? deviceName : "PC Loopback",
        album: "WASAPI Loopback",
        artwork: [
          { src: "/static/icon.png", sizes: "192x192", type: "image/png" },
        ],
      });
      navigator.mediaSession.setActionHandler("play", function () {
        try { audioEl.play(); } catch (e) {}
        if (audioCtx && audioCtx.state === "suspended") {
          audioCtx.resume().catch(function () {});
        }
      });
      navigator.mediaSession.setActionHandler("pause", function () {
        try { audioEl.pause(); } catch (e) {}
      });
      navigator.mediaSession.setActionHandler("stop", function () {
        if (playing) togglePlay();
      });
      navigator.mediaSession.playbackState = "playing";
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

  // ---- Web Worker inicializacion ----
  function initWorker() {
    if (worker) return;
    try {
      worker = new Worker("/static/audio_worker.js");
    } catch (err) {
      log("Worker ctor fallo:", err);
      return;
    }
    worker.onmessage = function (e) {
      const m = e.data;
      if (!m) return;
      switch (m.t) {
        case "open":
          connected = true;
          reconnectAttempts = 0;
          setWsBadge("Conectado", "live");
          log("Worker: WS abierto");
          break;
        case "format":
          fmt = m.fmt;
          stCodec.textContent = m.fmt.codec === 1 ? "mulaw" : "pcm";
          stFmt.textContent = (fmt.rate / 1000) + "k/" + fmt.channels + "ch";
          log("Formato: rate=" + fmt.rate + " ch=" + fmt.channels +
              " sw=" + fmt.sw + " hdrBytes=" + fmt.hdrBytes);
          break;
        case "audio":
          playBlock(m);
          break;
        case "silence":
          scheduleSilence(m.durMs);
          break;
        case "close":
          connected = false;
          setWsBadge("Desconectado", "off");
          log("Worker: WS cerrado (code=" + m.code + " reason=" + m.reason + ")");
          if (settings.autoReconnect) scheduleReconnect();
          break;
        case "rtt":
          stRtt.textContent = m.ms + " ms";
          break;
        case "device":
          deviceName = m.name;
          stDevice.textContent = deviceName;
          // Refrescar MediaSession ahora que sabemos el nombre.
          if (playing) setupMediaSession();
          break;
        case "lost":
          blocksLost += m.n;
          stLoss.textContent = String(blocksLost);
          break;
        case "error":
          log("Worker error:", m.err);
          break;
        case "stopped":
          log("Worker detenido.");
          break;
      }
    };
  }

  // ---- WS URL con query params derivados de settings ----
  function buildWsUrl() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const port = location.port ? ":" + location.port : "";
    const base = proto + location.hostname + port + "/ws";
    const q = new URLSearchParams();
    q.set("mono", settings.mono ? "1" : "0");
    if (settings.rate > 0) q.set("rate", String(settings.rate));
    q.set("skip", settings.skip ? "1" : "0");
    return base + "?" + q.toString();
  }

  function startStream() {
    initWorker();
    if (!worker) return;
    setWsBadge("conectando...", "recon");
    const url = buildWsUrl();
    log("Start stream -> ", url);
    worker.postMessage({ cmd: "start", url: url });
  }

  function stopStream() {
    if (worker) worker.postMessage({ cmd: "stop" });
  }

  // ---- Reproduccion de bloque (desde worker, zero-copy) ----
  function playBlock(m) {
    if (!audioCtx || audioCtx.state !== "running") return;
    if (!m.left) return;
    const frames = m.frames;
    if (frames === 0) return;

    const audioBuf = audioCtx.createBuffer(fmt.channels, frames, fmt.rate);
    try {
      audioBuf.copyToChannel(m.left, 0);
      if (fmt.channels > 1 && m.right) {
        audioBuf.copyToChannel(m.right, 1);
      }
    } catch (e) {
      log("copyToChannel fallo:", e);
      return;
    }

    const src = getFreeSource();
    if (src == null) return;
    src.buffer = audioBuf;
    src.connect(eqLowNode);

    const blockDur = frames / fmt.rate;
    blockDurMs = blockDur * 1000;

    // Jitter measurement (variabilidad de llegada).
    if (lastTsMs > 0) {
      const expected = lastTsMs + blockDurMsPrev;
      const jitter = Math.abs(m.ts - expected);
      if (jitter < 1000) {
        jitterSamples.push(jitter);
        if (jitterSamples.length > 60) jitterSamples.shift();
      }
    }
    lastTsMs = m.ts;
    blockDurMsPrev = blockDurMs;

    const now = audioCtx.currentTime;
    let t = nextPlayTime;
    const minStart = now + MIN_GAP_MS / 1000;
    const maxLat = MAX_LATENCY_MS / 1000;

    if (t < minStart) {
      // Underrun: crossfade simple, empezar en minStart.
      underruns++;
      stUnderrun.textContent = String(underruns);
      t = minStart;
    } else if (t - now > maxLat) {
      log("Realinear latencia:", (t - now).toFixed(3), "s");
      t = now + settings.latency / 1000;
    }

    try {
      src.start(t);
      src.stop(t + blockDur);
    } catch (e) {
      log("src.start fallo:", e);
      return;
    }
    nextPlayTime = t + blockDur;
  }

  function scheduleSilence(durMs) {
    if (!audioCtx || blockDurMs === 0) return;
    const frames = Math.round(blockDurMs * fmt.rate / 1000);
    if (frames === 0) return;
    const audioBuf = audioCtx.createBuffer(fmt.channels, frames, fmt.rate);
    const src = getFreeSource();
    if (src == null) return;
    src.buffer = audioBuf;
    src.connect(eqLowNode);
    const now = audioCtx.currentTime;
    let t = nextPlayTime;
    const minStart = now + MIN_GAP_MS / 1000;
    if (t < minStart) t = minStart;
    try {
      src.start(t);
      src.stop(t + frames / fmt.rate);
    } catch (e) { return; }
    nextPlayTime = t + frames / fmt.rate;
  }

  // ---- Stats display (jitter P95 + buffer) ----
  function startStatsUpdater() {
    if (statsUpdater) clearInterval(statsUpdater);
    statsUpdater = setInterval(function () {
      if (!audioCtx) return;
      const buffered = Math.max(0, nextPlayTime - audioCtx.currentTime);
      stBuffer.textContent = Math.round(buffered * 1000) + " ms";

      if (jitterSamples.length > 5) {
        const sorted = jitterSamples.slice().sort(function (a, b) { return a - b; });
        jitterP95 = sorted[Math.floor(sorted.length * 0.95)];
        stJitter.textContent = (jitterP95 | 0) + " ms";
      }
    }, 1000);
  }
  function stopStatsUpdater() {
    if (statsUpdater) { clearInterval(statsUpdater); statsUpdater = null; }
  }

  // ---- Reconexion con backoff exponencial ----
  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    setWsBadge("reconectando en " + Math.round(delay) + "ms", "recon");
    log("Reconnect en", delay, "ms (intento " + reconnectAttempts + ")");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (playing) startStream();
    }, delay);
  }

  // ---- WakeLock (refuerzo, no principal). MediaSession es la pieza clave ----
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    try {
      // Intentar "screen" primero (mas compatible). "system" es Chrome 125+.
      wakeLock = await navigator.wakeLock.request("screen");
      log("WakeLock activo (screen).");
      wakeLock.addEventListener("release", function () {
        log("WakeLock revocado por SO.");
        wakeLock = null;
        if (playing) requestWakeLock();
      });
    } catch (e) {
      log("WakeLock fallo:", e);
    }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) {}
      wakeLock = null;
    }
  }

  // ---- Toggle play ----
  async function togglePlay() {
    try { navigator.vibrate(10); } catch (e) {}

    if (playing) {
      stopStream();
      releaseWakeLock();
      clearMediaSession();
      stopStatsUpdater();
      if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl.srcObject = null; }
      if (audioCtx) {
        try { audioCtx.close(); } catch (e) {}
        audioCtx = null;
        mediaDest = null;
        gainNode = null;
        eqLowNode = eqMidNode = eqHighNode = null;
        sources.length = 0;
        poolIdx = 0;
      }
      setPlaying(false);
      setState("idle", false);
      stBuffer.textContent = "0 ms";
      stRtt.textContent = "--";
      underruns = 0;
      stUnderrun.textContent = "0";
      log("Reproduccion detenida.");
      return;
    }

    log("Boton INICIAR presionado.");
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      log("AudioContext no disponible");
      return;
    }
    try {
      audioCtx = new Ctx({ latencyHint: "interactive" });
    } catch (err) {
      log("AudioContext ctor fallo:", err);
      return;
    }
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (e) { log("resume fallo:", e); }
    }

    buildAudioGraph();
    nextPlayTime = audioCtx.currentTime + settings.latency / 1000;
    underruns = 0;
    blocksLost = 0;
    jitterSamples = [];
    lastTsMs = 0;
    blockDurMs = 0;
    blockDurMsPrev = 0;

    audioCtx.onstatechange = function () {
      log("AudioContext state:", audioCtx.state);
      if (audioCtx.state === "running") setState("live", true);
      else if (audioCtx.state === "suspended") setState("pausado", false);
    };

    // Arrancar <audio> con MediaStream (clave anti-Doze en Android).
    if (audioEl) {
      try {
        await audioEl.play();
        log("<audio>.play() OK");
      } catch (e) {
        log("<audio>.play() fallo:", e);
      }
    }

    setupMediaSession();
    setPlaying(true);
    setState("live", true);
    startStatsUpdater();
    startStream();
    requestWakeLock();
    log("Reproduccion iniciada.");
  }

  playBtn.addEventListener("click", togglePlay);

  // ---- Atajos teclado ----
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "KeyM") {
      settings.mono = !settings.mono;
      monoChk.checked = settings.mono;
      saveSettings(settings);
      log("mono toggled:", settings.mono, "(reconecta para aplicar)");
      if (connected) stopStream(), setTimeout(function () { if (playing) startStream(); }, 100);
    }
  });

  // ---- Panel de ajustes ----
  function applySettingsToUi() {
    latencySlider.value = settings.latency;
    if (latencyLbl) latencyLbl.textContent = settings.latency;
    codecSel.value = "pcm";
    monoChk.checked = settings.mono;
    skipChk.checked = settings.skip;
    eqLow.value = settings.eqLow;
    eqMid.value = settings.eqMid;
    eqHigh.value = settings.eqHigh;
    if (eqLowLbl) eqLowLbl.textContent = settings.eqLow;
    if (eqMidLbl) eqMidLbl.textContent = settings.eqMid;
    if (eqHighLbl) eqHighLbl.textContent = settings.eqHigh;
    reconnectChk.checked = settings.autoReconnect;
  }

  function reconnectStream(reason) {
    log("Reconexion solicitada:", reason);
    if (connected && worker) worker.postMessage({ cmd: "stop" });
    setTimeout(function () { if (playing) startStream(); }, 150);
  }

  function bindSettings() {
    latencySlider.addEventListener("input", function () {
      settings.latency = parseInt(latencySlider.value, 10);
      if (latencyLbl) latencyLbl.textContent = settings.latency;
      saveSettings(settings);
    });
    monoChk.addEventListener("change", function () {
      settings.mono = monoChk.checked;
      saveSettings(settings);
      reconnectStream("mono");
    });
    skipChk.addEventListener("change", function () {
      settings.skip = skipChk.checked;
      saveSettings(settings);
      reconnectStream("skip");
    });
    eqLow.addEventListener("input", function () {
      settings.eqLow = parseFloat(eqLow.value);
      if (eqLowLbl) eqLowLbl.textContent = settings.eqLow;
      if (eqLowNode) eqLowNode.gain.value = settings.eqLow;
      saveSettings(settings);
    });
    eqMid.addEventListener("input", function () {
      settings.eqMid = parseFloat(eqMid.value);
      if (eqMidLbl) eqMidLbl.textContent = settings.eqMid;
      if (eqMidNode) eqMidNode.gain.value = settings.eqMid;
      saveSettings(settings);
    });
    eqHigh.addEventListener("input", function () {
      settings.eqHigh = parseFloat(eqHigh.value);
      if (eqHighLbl) eqHighLbl.textContent = settings.eqHigh;
      if (eqHighNode) eqHighNode.gain.value = settings.eqHigh;
      saveSettings(settings);
    });
    reconnectChk.addEventListener("change", function () {
      settings.autoReconnect = reconnectChk.checked;
      saveSettings(settings);
    });
  }

  // ---- Overlay helpers ----
  function openOverlay(backdrop, panel) {
    if (backdrop) backdrop.classList.add("open");
    if (panel) panel.classList.add("open");
  }
  function closeOverlay(backdrop, panel) {
    if (backdrop) backdrop.classList.remove("open");
    if (panel) panel.classList.remove("open");
  }

  if (settingsBtn && settingsBackdrop && settingsPanel) {
    settingsBtn.addEventListener("click", function () {
      try { navigator.vibrate(10); } catch (e) {}
      openOverlay(settingsBackdrop, settingsPanel);
    });
    settingsClose.addEventListener("click", function () {
      closeOverlay(settingsBackdrop, settingsPanel);
    });
    settingsBackdrop.addEventListener("click", function (e) {
      if (e.target === settingsBackdrop) closeOverlay(settingsBackdrop, settingsPanel);
    });
  }
  if (statsBtn && statsBackdrop && statsPanel) {
    statsBtn.addEventListener("click", function () {
      try { navigator.vibrate(10); } catch (e) {}
      openOverlay(statsBackdrop, statsPanel);
    });
    statsClose.addEventListener("click", function () {
      closeOverlay(statsBackdrop, statsPanel);
    });
    statsBackdrop.addEventListener("click", function (e) {
      if (e.target === statsBackdrop) closeOverlay(statsBackdrop, statsPanel);
    });
  }
  if (eqToggle && eqBody) {
    eqToggle.addEventListener("click", function () {
      eqToggle.classList.toggle("open");
      eqBody.classList.toggle("open");
    });
  }

  // ---- Page Lifecycle: refrescar MediaSession + WakeLock al volver a foreground ----
  const onLifecycleResume = function () {
    log("Lifecycle resume.");
    if (playing) {
      requestWakeLock();
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(function () {});
      }
      if (audioEl && audioEl.paused) {
        audioEl.play().catch(function () {});
      }
      // Realinear nextPlayTime si gap grande post-suspension.
      if (audioCtx) {
        const gap = audioCtx.currentTime - nextPlayTime;
        if (gap > 2) {
          log("Gap post-suspension: " + gap.toFixed(1) + "s -> realinear.");
          nextPlayTime = audioCtx.currentTime + settings.latency / 1000;
          for (var k = 0; k < Math.min(Math.round(gap / 0.1), 20); k++) {
            scheduleSilence(blockDurMs);
          }
          nextPlayTime = audioCtx.currentTime + settings.latency / 1000;
        }
      }
      if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
    }
  };
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) onLifecycleResume();
  });
  if ("onfreeze" in document) {
    document.addEventListener("freeze", function () {
      log("Lifecycle freeze. Estado guardado.");
    });
    document.addEventListener("resume", onLifecycleResume);
  }

  // ---- Arranque ----
  applySettingsToUi();
  bindSettings();
  log("PyAB v2 listo (Worker + MediaSession).");
  log("WS_URL:", buildWsUrl());

  // No auto-conectar: requiere gesto usuario (politica autoplay movil).
  // El primer tab en playBtn arranca AudioContext + Worker + <audio>.

  // Debug hook.
  window.PyAB = {
    settings: settings,
    getAudioCtx: function () { return audioCtx; },
    getWorker: function () { return worker; },
  };
})();
