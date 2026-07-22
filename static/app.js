/* app.js - PyAudioBridge cliente movil.
 *
 * Tareas:
 *   1. Boton flotante inicia AudioContext (politica autoplay movil).
 *   2. WebSocket binario -> Int16Array -> Float32Array [-1,1].
 *   3. Jitter buffer sobre la linea de tiempo currentTime:
 *        - Cada bloque se agenda como AudioBufferSourceNode encadenado
 *          al final del ultimo fragmento programado.
 *        - Si la brecha es grande > MAX_LATENCY, realineamos (skip)
 *          para no acumular retraso.
 *        - Si el ultimo schedule esta muy cerca del currentTime, dejamos
 *          un MIN_GAP para no cortar el bloque actual (anti-underrun).
 *   4. Reconexion automatica exponencial.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------------
  // Configuracion
  // ------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const WS_URL =
    params.get("ws") ||
    ((location.protocol === "https:" ? "wss://" : "ws://") +
      location.hostname +
      (location.port ? ":" + location.port : "") +
      "/ws");

  const SAMPLE_RATE = 44100;
  const CHANNELS = 2;
  const TARGET_LATENCY_MS = 120;
  const MAX_LATENCY_MS = 500;
  const MIN_GAP_MS = 20;
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 8000;

  // ------------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------------
  const playBtn = document.getElementById("playBtn");
  const playIcon = document.getElementById("playIcon");
  const playLabel = document.getElementById("playLabel");
  const wsBadge = document.getElementById("wsBadge");
  const deviceLbl = document.getElementById("deviceLbl");
  const stState = document.getElementById("stState");
  const stBuffer = document.getElementById("stBuffer");
  const stUnderrun = document.getElementById("stUnderrun");
  const vol = document.getElementById("vol");

  // ------------------------------------------------------------------------
  // Estado
  // ------------------------------------------------------------------------
  let audioCtx = null;
  let gainNode = null;
  let ws = null;
  let connected = false;
  let playing = false;
  let nextPlayTime = 0;
  let blockCount = 0;
  let underruns = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let deviceName = "?";
  let incomingSampleRate = SAMPLE_RATE;
  let incomingChannels = CHANNELS;
  let statsLast = performance.now();
  let headerParsed = false;

  // ------------------------------------------------------------------------
  // Utilidades UI
  // ------------------------------------------------------------------------
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

  function log(level) {
    var args = Array.prototype.slice.call(arguments, 1);
    var prefix = "[PyAB]";
    args.unshift(prefix);
    if (level === "warn") console.warn.apply(console, args);
    else if (level === "error") console.error.apply(console, args);
    else console.log.apply(console, args);
  }

  // ------------------------------------------------------------------------
  // WebSocket
  // ------------------------------------------------------------------------
  function connect() {
    setWsBadge("conectando...", "recon");
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      log("error", "WebSocket ctor fallo:", err);
      scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      connected = true;
      reconnectAttempts = 0;
      headerParsed = false;
      setWsBadge("WS conectado", "live");
      log("", "WebSocket abierto:", WS_URL);
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
      log("warn", "WebSocket cerrado.");
      scheduleReconnect();
    };
    ws.onerror = function (err) {
      log("error", "WS error:", err);
    };
  }

  function handleText(text) {
    if (text === "pong") { log("", "pong recibido"); return; }
    if (text.startsWith("device:")) {
      deviceName = text.slice(7).trim();
      deviceLbl.textContent = "dispositivo: " + deviceName;
    }
  }

  function handleBinary(buf) {
    if (!headerParsed) {
      if (buf.byteLength >= 16) {
        var view = new DataView(buf);
        var magic = String.fromCharCode(
          view.getUint8(0), view.getUint8(1),
          view.getUint8(2), view.getUint8(3)
        );
        if (magic === "PYAB") {
          incomingSampleRate = view.getUint32(4, true);
          incomingChannels = view.getUint32(8, true);
          var sw = view.getUint32(12, true);
          headerParsed = true;
          log("", "Header: rate=" + incomingSampleRate + " ch=" + incomingChannels + " sw=" + sw);
          return;
        }
      }
    }
    handleAudioBlock(buf);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    setWsBadge("reconectando en " + Math.round(delay) + "ms", "recon");
    log("", "Reconnect en", delay, "ms (intento", reconnectAttempts, ")");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendText(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(text); } catch (_) {}
    }
  }

  // ------------------------------------------------------------------------
  // Jitter buffer + scheduling Web Audio API
  // ------------------------------------------------------------------------
  function ensureContext() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(function (err) {
          log("error", "Resume fallo:", err);
        });
      }
      return;
    }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    log("", "Creando AudioContext...");
    try {
      audioCtx = new Ctx({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    } catch (err) {
      // Fallback: sin sampleRate explicito
      log("warn", "AudioContext con rate explicito fallo, reintento sin el:", err);
      try {
        audioCtx = new Ctx({ latencyHint: "interactive" });
      } catch (err2) {
        log("error", "AudioContext no disponible:", err2);
        return;
      }
    }

    gainNode = audioCtx.createGain();
    gainNode.gain.value = vol.value / 100;
    gainNode.connect(audioCtx.destination);

    nextPlayTime = audioCtx.currentTime + TARGET_LATENCY_MS / 1000;
    blockCount = 0;
    underruns = 0;

    audioCtx.onstatechange = function () {
      log("", "AudioContext state:", audioCtx.state);
      if (audioCtx.state === "running") {
        setState("live", true);
      } else if (audioCtx.state === "suspended") {
        setState("pausado", false);
      }
    };

    log("", "AudioContext creado. state:", audioCtx.state);
  }

  function handleAudioBlock(buf) {
    if (!audioCtx || audioCtx.state !== "running") {
      log("", "Bloque recibido pero audioCtx inactivo (" + (audioCtx ? audioCtx.state : "null") + ")");
      return;
    }

    var bytes = new Uint8Array(buf);
    var nSamples = bytes.byteLength >> 1;
    if (nSamples < 2) return;
    var int16 = new Int16Array(bytes.buffer, 0, nSamples);
    var frames = Math.floor(nSamples / incomingChannels);
    if (frames === 0) return;

    // Int16 -> Float32 interleaved
    var float = new Float32Array(frames * incomingChannels);
    for (var i = 0; i < nSamples; i++) {
      float[i] = int16[i] / 32768;
    }

    var audioBuf = audioCtx.createBuffer(incomingChannels, frames, incomingSampleRate);
    if (incomingChannels === 1) {
      audioBuf.copyToChannel(float, 0);
    } else {
      var left = new Float32Array(frames);
      var right = new Float32Array(frames);
      for (var j = 0; j < frames; j++) {
        left[j] = float[j * 2];
        right[j] = float[j * 2 + 1];
      }
      audioBuf.copyToChannel(left, 0);
      audioBuf.copyToChannel(right, 1);
    }

    var src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(gainNode);

    var now = audioCtx.currentTime;
    var blockDur = frames / incomingSampleRate;

    var t = nextPlayTime;
    var minStart = now + MIN_GAP_MS / 1000;
    var maxLat = MAX_LATENCY_MS / 1000;

    if (t < minStart) {
      underruns++;
      stUnderrun.textContent = String(underruns);
      t = minStart;
    } else if (t - now > maxLat) {
      log("", "Realinear latencia: " + (t - now).toFixed(3) + "s");
      t = now + TARGET_LATENCY_MS / 1000;
    }

    src.start(t);
    nextPlayTime = t + blockDur;
    blockCount++;
    updateStats();
  }

  function updateStats() {
    var now = performance.now();
    if (now - statsLast < 3000) return; // cada 3s
    statsLast = now;
    if (!audioCtx) return;
    var buffered = Math.max(0, nextPlayTime - audioCtx.currentTime);
    stBuffer.textContent = Math.round(buffered * 1000) + " ms";
  }

  // ------------------------------------------------------------------------
  // UI handlers
  // ------------------------------------------------------------------------
  function togglePlay() {
    if (playing) {
      if (audioCtx) {
        audioCtx.close().catch(function () {});
        audioCtx = null;
        gainNode = null;
      }
      setPlaying(false);
      setState("idle", false);
      stBuffer.textContent = "0 ms";
      log("", "Reproduccion detenida.");
      return;
    }
    log("", "Boton INICIAR presionado.");
    ensureContext();
    if (!audioCtx) {
      log("error", "No se pudo crear AudioContext");
      return;
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(function (err) {
        log("error", "Resume fallo:", err);
      });
    }
    setPlaying(true);
    setState("live", true);
    if (connected) sendText("ping");
    log("", "Reproduccion iniciada. headerParsed=" + headerParsed + " connected=" + connected);
  }

  playBtn.addEventListener("click", togglePlay);

  vol.addEventListener("input", function () {
    if (gainNode) gainNode.gain.value = vol.value / 100;
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
  });

  // ------------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------------
  log("", "WS_URL:", WS_URL);
  connect();
})();
