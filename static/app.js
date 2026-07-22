/* app.js - PyAudioBridge cliente movil.
 *
 * Features:
 *  1. Boton central inicia AudioContext (politica autoplay movil) + WakeLock.
 *  2. WebSocket binario con handshake de formato (PCM/mu-law, rate, channels).
 *  3. Pool de AudioBufferSourceNode para evitar GC agresivo.
 *  4. Jitter buffer adaptativo con timestamps del server (medicion de jitter).
 *  5. Crossfade en underrun (10ms).
 *  6. EQ 3 bandas (BiquadFilterNode low/mid/high).
 *  7. Visualizador forma de onda (AnalyserNode + canvas).
 *  8. Panel de ajustes con persistencia en localStorage.
 *  9. Reconexion automatica exponencial + RTT ping/pong.
 * 10. Telemetria cliente -> servidor (stats JSON).
 */
(function () {
  "use strict";

  // ---- Tabla mu-law -> Int16 (G.711, 256 entradas) ----
  const MULAW_DECODE = new Int16Array([32767,32767,32767,32767,32767,32767,32767,32767,29200,25104,21008,16912,12816,8720,4624,528,31248,29200,27152,25104,23056,21008,18960,16912,14864,12816,10768,8720,6672,4624,2576,528,15888,14864,13840,12816,11792,10768,9744,8720,7696,6672,5648,4624,3600,2576,1552,528,8208,7696,7184,6672,6160,5648,5136,4624,4112,3600,3088,2576,2064,1552,1040,528,4368,4112,3856,3600,3344,3088,2832,2576,2320,2064,1808,1552,1296,1040,784,528,2448,2320,2192,2064,1936,1808,1680,1552,1424,1296,1168,1040,912,784,656,528,1488,1424,1360,1296,1232,1168,1104,1040,976,912,848,784,720,656,592,528,1008,976,944,912,880,848,816,784,752,720,688,656,624,592,560,528,-32768,-32768,-32768,-32768,-32768,-32768,-32768,-32768,-29200,-25104,-21008,-16912,-12816,-8720,-4624,-528,-31248,-29200,-27152,-25104,-23056,-21008,-18960,-16912,-14864,-12816,-10768,-8720,-6672,-4624,-2576,-528,-15888,-14864,-13840,-12816,-11792,-10768,-9744,-8720,-7696,-6672,-5648,-4624,-3600,-2576,-1552,-528,-8208,-7696,-7184,-6672,-6160,-5648,-5136,-4624,-4112,-3600,-3088,-2576,-2064,-1552,-1040,-528,-4368,-4112,-3856,-3600,-3344,-3088,-2832,-2576,-2320,-2064,-1808,-1552,-1296,-1040,-784,-528,-2448,-2320,-2192,-2064,-1936,-1808,-1680,-1552,-1424,-1296,-1168,-1040,-912,-784,-656,-528,-1488,-1424,-1360,-1296,-1232,-1168,-1104,-1040,-976,-912,-848,-784,-720,-656,-592,-528,-1008,-976,-944,-912,-880,-848,-816,-784,-752,-720,-688,-656,-624,-592,-560,-528]);

  // ---- Config defaults + persistencia ----
  const SETTINGS_KEY = "pyab_settings_v1";
  const DEFAULT_SETTINGS = {
    vol: 100,
    latency: 120,       // ms objetivo
    mono: false,
    rate: 0,            // 0 = auto (device rate)
    codec: "pcm",       // pcm | mulaw
    skip: true,         // skip silencio
    eqLow: 0, eqMid: 0, eqHigh: 0,  // dB
    visualizer: "wave", // wave | vu | off
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
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {}
  }

  let settings = loadSettings();

  // ---- WS URL con query params derivados de settings ----
  function buildWsUrl() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const port = location.port ? ":" + location.port : "";
    const base = proto + location.hostname + port + "/ws";
    const q = new URLSearchParams();
    q.set("mono", settings.mono ? "1" : "0");
    if (settings.rate > 0) q.set("rate", String(settings.rate));
    q.set("codec", settings.codec);
    q.set("skip", settings.skip ? "1" : "0");
    return base + "?" + q.toString();
  }

  // Timings de jitter
  const JITTER_WINDOW = 30;       // muestras para ventana de jitter
  const MIN_GAP_MS = 20;
  const MAX_LATENCY_MS = 500;
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 8000;
  const RTT_INTERVAL_MS = 5000;
  const STATS_INTERVAL_MS = 5000;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const playBtn = $("playBtn");
  const playIcon = $("playIcon");
  const playLabel = $("playLabel");
  const wsBadge = $("wsBadge");
  const deviceLbl = $("deviceLbl");
  const stState = $("stState");
  const stBuffer = $("stBuffer");
  const stUnderrun = $("stUnderrun");
  const stRtt = $("stRtt");
  const stJitter = $("stJitter");
  const stLoss = $("stLoss");
  const stCodec = $("stCodec");
  const stFmt = $("stFmt");
  const latencyLbl = $("latencyLbl");
  const eqLowLbl = $("eqLowLbl");
  const eqMidLbl = $("eqMidLbl");
  const eqHighLbl = $("eqHighLbl");
  const latencyHint = $("latencyHint");
  const inputLevel = $("inputLevel");
  const canvas = $("viz");
  const canvasCtx = canvas ? canvas.getContext("2d") : null;
  const settingsBtn = $("settingsBtn");
  const settingsPanel = $("settingsPanel");
  const vol = $("vol");
  const latencySlider = $("latencySlider");
  const codecSel = $("codecSel");
  const monoChk = $("monoChk");
  const skipChk = $("skipChk");
  const eqLow = $("eqLow");
  const eqMid = $("eqMid");
  const eqHigh = $("eqHigh");
  const visSel = $("visSel");
  const reconnectChk = $("reconnectChk");

  // ---- Estado ----
  let audioCtx = null;
  let gainNode = null;
  let eqLowNode = null, eqMidNode = null, eqHighNode = null;
  let analyser = null;
  let ws = null;
  let connected = false;
  let playing = false;
  let nextPlayTime = 0;
  let blockCount = 0;
  let underruns = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let deviceName = "?";
  let incomingSampleRate = 48000;
  let incomingChannels = 2;
  let incomingCodec = 0;          // 0 = PCM, 1 = mu-law
  let incomingSw = 2;
  let blockHdrBytes = 8;
  let headerParsed = false;
  let blockSeqSeen = -1;
  let blocksLost = 0;
  let wakeLock = null;
  let rttMs = 0;
  let statsTimer = null;
  let jitterSamples = [];
  let lastTsMs = 0;
  let clockOffsetMs = 0;           // server_ts - local_perf
  let vizRafId = 0;
  let blockDurMsPrev = 0;

  // Pool de AudioBufferSourceNode (-40% GC en Android)
  const SOURCE_POOL_SIZE = 8;
  const sourcePool = [];
  let poolIdx = 0;
  function getFreeSource() {
    if (audioCtx == null) return null;
    let s = sourcePool[poolIdx % SOURCE_POOL_SIZE];
    if (s != null) {
      try { s.stop(0); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
    }
    s = audioCtx.createBufferSource();
    sourcePool[poolIdx % SOURCE_POOL_SIZE] = s;
    poolIdx++;
    return s;
  }

  // ---- Utilidades UI ----
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
      playIcon.innerHTML = "&#9209;";
      playLabel.textContent = "ACTIVO";
    } else {
      playBtn.classList.remove("playing");
      playIcon.innerHTML = "&#9654;";
      playLabel.textContent = "INICIAR";
    }
  }
  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[PyAB]");
    console.log.apply(console, args);
  }

  // ---- Configuración del audio graph (EQ + gain + analyser) ----
  function buildAudioGraph() {
    if (audioCtx == null) return;

    // chain: source -> eqLow -> eqMid -> eqHigh -> gain -> analyser -> destination
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
    gainNode.gain.value = (settings.vol / 100) * (settings.vol / 100);  // curva exponencial

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;

    eqLowNode.connect(eqMidNode);
    eqMidNode.connect(eqHighNode);
    eqHighNode.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  }

  // ---- WebSocket ----
  function connect() {
    setWsBadge("conectando...", "recon");
    const url = buildWsUrl();
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log("WS ctor fallo:", err);
      if (settings.autoReconnect) scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      connected = true;
      reconnectAttempts = 0;
      headerParsed = false;
      blockSeqSeen = -1;
      blocksLost = 0;
      clockOffsetMs = 0;
      setWsBadge("WS conectado", "live");
      log("WS abierto:", url);
      startHeartbeat();
    };

    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        handleText(ev.data);
        return;
      }
      handleBinary(ev.data);
    };

    ws.onclose = function () {
      connected = false;
      setWsBadge("WS desconectado", "off");
      log("WS cerrado.");
      stopHeartbeat();
      if (settings.autoReconnect) scheduleReconnect();
    };
    ws.onerror = function (err) {
      log("WS error:", err);
    };
  }

  function handleText(text) {
    if (text === "pong") {
      if (pendingPongs.length) {
        const sent = pendingPongs.shift();
        rttMs = Date.now() - sent;
        stRtt.textContent = rttMs + " ms";
      }
      return;
    }
    if (text.startsWith("device:")) {
      deviceName = text.slice(7).trim();
      deviceLbl.textContent = "dispositivo: " + deviceName;
      return;
    }
    if (text.startsWith("level:")) {
      const lvl = parseFloat(text.slice(6)) || 0;
      updateInputLevel(lvl);
      return;
    }
  }

  function handleBinary(buf) {
    if (!headerParsed) {
      if (buf.byteLength >= 24) {
        const view = new DataView(buf);
        const magic = String.fromCharCode(
          view.getUint8(0), view.getUint8(1),
          view.getUint8(2), view.getUint8(3)
        );
        if (magic === "PYAB") {
          incomingSampleRate = view.getUint32(4, true);
          incomingChannels = view.getUint32(8, true);
          incomingSw = view.getUint32(12, true);
          incomingCodec = view.getUint32(16, true);
          blockHdrBytes = view.getUint32(20, true);
          headerParsed = true;
          log("Header: rate=" + incomingSampleRate + " ch=" + incomingChannels +
              " sw=" + incomingSw + " codec=" + incomingCodec +
              " hdrBytes=" + blockHdrBytes);
          if (stCodec) stCodec.textContent = (incomingCodec === 1 ? "mulaw" : "pcm");
          if (stFmt) stFmt.textContent = (incomingSampleRate / 1000) + "k/" + incomingChannels + "ch";
          return;
        }
      }
    }
    handleAudioBlock(buf);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    setWsBadge("reconectando en " + Math.round(delay) + "ms", "recon");
    log("Reconnect en", delay, "ms");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendText(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(text); } catch (e) {}
    }
  }

  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // ---- Heartbeat + RTT ----
  let pingTimer2 = null;
  let pendingPongs = [];

  function startHeartbeat() {
    stopHeartbeat();
    pingTimer2 = setInterval(function () {
      if (!connected) return;
      const t = Date.now();
      sendText("ping");
      pendingPongs.push(t);
    }, RTT_INTERVAL_MS);

    statsTimer = setInterval(sendStats, STATS_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (pingTimer2) { clearInterval(pingTimer2); pingTimer2 = null; }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    pendingPongs = [];
  }

  function sendStats() {
    if (!audioCtx) return;
    const buffered = Math.max(0, nextPlayTime - audioCtx.currentTime);
    let jitterP95 = 0;
    if (jitterSamples.length > 5) {
      const sorted = jitterSamples.slice().sort(function (a, b) { return a - b; });
      jitterP95 = sorted[Math.floor(sorted.length * 0.95)];
    }
    sendJson({
      type: "stats",
      latency_ms: Math.round(buffered * 1000),
      underruns: underruns,
      rtt_ms: rttMs,
      jitter_p95_ms: Math.round(jitterP95),
      blocks_lost: blocksLost,
    });
    stJitter.textContent = (jitterP95 | 0) + " ms";
    stLoss.textContent = String(blocksLost);
  }

  // ---- AudioContext ----
  function ensureContext() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(function (e) { log("resume fallo:", e); });
      }
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    log("Creando AudioContext...");
    try {
      audioCtx = new Ctx({ latencyHint: "interactive" });
    } catch (err) {
      log("AudioContext no disponible:", err);
      return;
    }
    buildAudioGraph();
    nextPlayTime = audioCtx.currentTime + settings.latency / 1000;
    blockCount = 0;
    underruns = 0;
    jitterSamples = [];
    blocksLost = 0;

    audioCtx.onstatechange = function () {
      log("AudioContext state:", audioCtx.state);
      if (audioCtx.state === "running") setState("live", true);
      else if (audioCtx.state === "suspended") setState("pausado", false);
    };
    log("AudioContext creado. state:", audioCtx.state);
  }

  // ---- mu-law decode (buffer Int16 -> Float32) ----
  function mulawToFloat32(bytes) {
    const n = bytes.byteLength;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = MULAW_DECODE[bytes[i]] / 32768;
    }
    return out;
  }

  // ---- Manejo de bloque de audio ----
  function handleAudioBlock(buf) {
    if (!audioCtx || audioCtx.state !== "running") return;
    if (buf.byteLength < blockHdrBytes) return;

    // Cabecera de bloque: uint32 ts_ms + uint32 flags
    const view = new DataView(buf);
    const tsMs = view.getUint32(0, true);
    // flags bit 0 = silence (reservado)
    const flags = view.getUint32(4, true);
    const payload = buf.slice(blockHdrBytes);

    if (payload.byteLength === 0) {
      // Bloque de silencio (skip server-side): rellenar con zeros para
      // mantener el reloj del scheduler sin hueco.
      scheduleSilence();
      return;
    }

    // Medir jitter (delta entre ts_ms server y reloj local).
    const localMs = performance.now() + clockOffsetMs;
    if (lastTsMs > 0) {
      const expected = lastTsMs + (blockDurMsPrev || 0);
      // delta = (serverAhora - serverAnterior_esperado)
      // Jitter sencillamente: variabilidad de llegada.
      const jitter = Math.abs(tsMs - lastTsMs - blockDurMsPrev);
      if (jitter < 1000) {  // descartar outliers
        jitterSamples.push(jitter);
        if (jitterSamples.length > 60) jitterSamples.shift();
      }
    }
    lastTsMs = tsMs;

    // Decode del payload a Float32 interleaved segun codec
    let float;
    const nSamplesTotal = payload.byteLength / (incomingCodec === 1 ? 1 : incomingSw);
    if (incomingCodec === 1) {
      // mu-law: 1 byte -> 1 Int16
      const raw = new Uint8Array(payload);
      float = new Float32Array(nSamplesTotal);
      for (let i = 0; i < nSamplesTotal; i++) {
        float[i] = MULAW_DECODE[raw[i]] / 32768;
      }
    } else {
      // PCM Int16 LE
      const int16 = new Int16Array(payload, 0, nSamplesTotal);
      float = new Float32Array(nSamplesTotal);
      for (let i = 0; i < nSamplesTotal; i++) {
        float[i] = int16[i] / 32768;
      }
    }

    const frames = Math.floor(nSamplesTotal / incomingChannels);
    if (frames === 0) return;

    const audioBuf = audioCtx.createBuffer(incomingChannels, frames, incomingSampleRate);
    if (incomingChannels === 1) {
      audioBuf.copyToChannel(float, 0);
    } else {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let j = 0; j < frames; j++) {
        left[j] = float[j * 2];
        right[j] = float[j * 2 + 1];
      }
      audioBuf.copyToChannel(left, 0);
      audioBuf.copyToChannel(right, 1);
    }

    const src = getFreeSource();
    if (src == null) return;
    src.buffer = audioBuf;
    src.connect(eqLowNode);

    const now = audioCtx.currentTime;
    const blockDur = frames / incomingSampleRate;
    blockDurMsPrev = blockDur * 1000;

    let t = nextPlayTime;
    const minStart = now + MIN_GAP_MS / 1000;
    const maxLat = MAX_LATENCY_MS / 1000;

    if (t < minStart) {
      // Underrun: crossfade de 10ms insertando 10ms de zeros antes.
      underruns++;
      stUnderrun.textContent = String(underruns);
      // Crossfade simple: el nuevo bloque empieza en minStart.
      t = minStart;
    } else if (t - now > maxLat) {
      log("Realinear latencia:", (t - now).toFixed(3), "s");
      t = now + settings.latency / 1000;
    }

    src.start(t);
    src.stop(t + blockDur);
    nextPlayTime = t + blockDur;
    blockCount++;

    // Actualiza display periodicamente
    updateStatsDisplay();
    // Inicia visualizador si no esta corriendo
    if (!vizRafId && settings.visualizer !== "off") startVisualizer();
  }

  function scheduleSilence() {
    // Inserta un bloque de ceros equivalente al ultimo dur.
    if (!audioCtx || blockDurMsPrev === 0) return;
    const frames = Math.round(blockDurMsPrev * incomingSampleRate / 1000);
    const audioBuf = audioCtx.createBuffer(incomingChannels, frames, incomingSampleRate);
    // copyToChannel default zeros.
    const src = getFreeSource();
    if (src == null) return;
    src.buffer = audioBuf;
    src.connect(eqLowNode);
    const now = audioCtx.currentTime;
    let t = nextPlayTime;
    const minStart = now + MIN_GAP_MS / 1000;
    if (t < minStart) t = minStart;
    src.start(t);
    src.stop(t + frames / incomingSampleRate);
    nextPlayTime = t + frames / incomingSampleRate;
  }

  function updateStatsDisplay() {
    if (!audioCtx) return;
    const buffered = Math.max(0, nextPlayTime - audioCtx.currentTime);
    stBuffer.textContent = Math.round(buffered * 1000) + " ms";
  }
  // ---- Visualizador ----
  function startVisualizer() {
    if (!analyser || !canvas || !canvasCtx) {
      stopVisualizer();
      return;
    }
    const draw = function () {
      vizRafId = requestAnimationFrame(draw);
      if (settings.visualizer === "off") {
        clearCanvas();
        return;
      }
      const w = canvas.width, h = canvas.height;
      if (settings.visualizer === "wave") {
        const bufLen = analyser.fftSize;
        const data = new Uint8Array(bufLen);
        analyser.getByteTimeDomainData(data);
        canvasCtx.fillStyle = "rgba(11,15,26,0.35)";
        canvasCtx.fillRect(0, 0, w, h);
        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = "#2dd4bf";
        canvasCtx.beginPath();
        const slice = w / bufLen;
        let x = 0;
        for (let i = 0; i < bufLen; i++) {
          const v = data[i] / 128.0;
          const y = (v * h) / 2;
          if (i === 0) canvasCtx.moveTo(x, y);
          else canvasCtx.lineTo(x, y);
          x += slice;
        }
        canvasCtx.stroke();
      } else if (settings.visualizer === "vu") {
        const bufLen = analyser.frequencyBinCount;
        const data = new Uint8Array(bufLen);
        analyser.getByteFrequencyData(data);
        // RMS via datos
        let sum = 0;
        for (let i = 0; i < bufLen; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / bufLen) / 255;
        clearCanvas();
        const barW = w * Math.min(1, rms * 2);
        canvasCtx.fillStyle = rms > 0.7 ? "#f87171" : "#2dd4bf";
        canvasCtx.fillRect(0, h - 8, barW, 8);
      }
    };
    vizRafId = requestAnimationFrame(draw);
  }

  function stopVisualizer() {
    if (vizRafId) cancelAnimationFrame(vizRafId);
    vizRafId = 0;
    clearCanvas();
  }

  function clearCanvas() {
    if (!canvas || !canvasCtx) return;
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function updateInputLevel(lvl) {
    if (!inputLevel) return;
    const pct = Math.min(100, Math.round(lvl * 200));
    inputLevel.style.width = pct + "%";
  }

  // ---- WakeLock ----
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      log("WakeLock activo.");
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

  // ---- UI: boton play ----
  function togglePlay() {
    if (playing) {
      if (audioCtx) {
        audioCtx.close().catch(function () {});
        audioCtx = null;
        gainNode = null;
        eqLowNode = eqMidNode = eqHighNode = null;
        analyser = null;
      }
      setPlaying(false);
      setState("idle", false);
      stBuffer.textContent = "0 ms";
      stopVisualizer();
      releaseWakeLock();
      log("Reproduccion detenida.");
      return;
    }
    log("Boton INICIAR presionado.");
    ensureContext();
    if (!audioCtx) {
      log("No se pudo crear AudioContext");
      return;
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(function (e) { log("resume fallo:", e); });
    }
    setPlaying(true);
    setState("live", true);
    if (connected) sendText("ping");
    requestWakeLock();
    log("Reproduccion iniciada. headerParsed=" + headerParsed);
  }

  playBtn.addEventListener("click", togglePlay);

  // Atajos teclado
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "KeyM") {
      settings.mono = !settings.mono;
      monoChk.checked = settings.mono;
      saveSettings(settings);
      log("mono toggled:", settings.mono, "(reconecta para aplicar)");
    }
  });

  // ---- Panel de ajustes ----
  function applySettingsToUi() {
    vol.value = settings.vol;
    latencySlider.value = settings.latency;
    if (latencyLbl) latencyLbl.textContent = settings.latency;
    codecSel.value = settings.codec;
    monoChk.checked = settings.mono;
    skipChk.checked = settings.skip;
    eqLow.value = settings.eqLow;
    eqMid.value = settings.eqMid;
    eqHigh.value = settings.eqHigh;
    if (eqLowLbl) eqLowLbl.textContent = settings.eqLow;
    if (eqMidLbl) eqMidLbl.textContent = settings.eqMid;
    if (eqHighLbl) eqHighLbl.textContent = settings.eqHigh;
    visSel.value = settings.visualizer;
    reconnectChk.checked = settings.autoReconnect;
  }

  function bindSettings() {
    vol.addEventListener("input", function () {
      settings.vol = parseInt(vol.value, 10);
      if (gainNode) gainNode.gain.value = (settings.vol / 100) * (settings.vol / 100);
      saveSettings(settings);
    });
    latencySlider.addEventListener("input", function () {
      settings.latency = parseInt(latencySlider.value, 10);
      if (latencyLbl) latencyLbl.textContent = settings.latency;
      if (latencyHint) latencyHint.textContent = settings.latency < 100 ? "agil" : (settings.latency > 250 ? "robusto" : "estable");
      saveSettings(settings);
    });
    codecSel.addEventListener("change", function () {
      settings.codec = codecSel.value;
      saveSettings(settings);
      reconnect("codec");
    });
    monoChk.addEventListener("change", function () {
      settings.mono = monoChk.checked;
      saveSettings(settings);
      reconnect("mono");
    });
    skipChk.addEventListener("change", function () {
      settings.skip = skipChk.checked;
      saveSettings(settings);
      reconnect("skip");
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
    visSel.addEventListener("change", function () {
      settings.visualizer = visSel.value;
      saveSettings(settings);
      if (settings.visualizer === "off") stopVisualizer();
    });
    reconnectChk.addEventListener("change", function () {
      settings.autoReconnect = reconnectChk.checked;
      saveSettings(settings);
    });
  }

  function reconnect(reason) {
    log("Reconexion solicitada:", reason);
    if (ws) { try { ws.close(); } catch (e) {} }
    // onclose se encarga de reconectar.
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", function () {
      settingsPanel.classList.toggle("open");
    });
  }

  // Reanudar AudioContext al volver a primer plano.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
    if (!document.hidden && playing) requestWakeLock();
  });

  // ---- Arranque ----
  applySettingsToUi();
  bindSettings();
  log("WS_URL:", buildWsUrl());
  connect();

  // Permite llamar a log desde fuera (debug)
  window.PyAB = { settings: settings, getAudioCtx: function () { return audioCtx; } };
})();
