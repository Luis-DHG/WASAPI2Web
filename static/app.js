/* app.js — cliente WS+Opus/WASM para el motor Rust (pywebrtcsink-core).
 *
 * Flujo:
 *   1. WS a ws://<host>:8090 — frames binarios [seq:u32BE | ts:u32BE | opus].
 *   2. opus-decoder (WASM, vendoreado en vendor/) -> PCM f32 48kHz estereo.
 *      Un solo path para todos los browsers (WebCodecs no existe en Firefox/Safari).
 *   3. Scheduler sobre AudioContext: buffer 60ms objetivo, encola AudioBufferSource
 *      por frame. Gaps de seq solo comprimen tiempo (silencio breve, sin drift).
 *   4. MediaSession + mute local (gain node).
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var playBtn = $("playBtn"), playLabel = $("playLabel"), playIcon = $("playIcon"),
    hintCtx = $("hintCtx"), wsBadge = $("wsBadge"),
    muteBtn = $("muteBtn"), muteIcon = $("muteIcon"), muteLabel = $("muteLabel"),
    mediaKeyBtn = $("mediaKeyBtn");

  if (!window.AudioContext && !window.webkitAudioContext) {
    hintCtx.textContent = "Este navegador no soporta WebAudio.";
    return;
  }
  if (!window["opus-decoder"]) {
    hintCtx.textContent = "No cargó el decoder Opus (vendor/opus-decoder.min.js).";
    return;
  }

  var WS_PORT = 8090;
  var TARGET_BUF_S = 0.06;         // 60ms de jitter buffer (3 frames de 20ms)
  var MAX_AHEAD_S = 0.5;           // techo de scheduling (vuelta de background)
  var RECONNECT_BASE_MS = 500, RECONNECT_MAX_MS = 5000;

  var playing = false, muted = false;
  var ws = null, audioCtx = null, gainNode = null, opusDecoder = null;
  var nextStart = 0;               // reloj de scheduling
  var lastSeq = -1;                // deteccion de huecos (solo log)
  var lastFrameTs = 0;             // watchdog simple del stream
  var lastErrTs = 0;               // throttle de errores en UI
  var reconnectTimer = null, reconnectAttempts = 0;

  function log() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift("[Sink]");
    console.log.apply(console, a);
  }
  function setBadge(t, c) {
    wsBadge.textContent = t;
    wsBadge.className = "badge " + (c || "");
    [muteBtn, mediaKeyBtn].forEach(function (b) { if (b) b.disabled = (c !== "live"); });
  }
  function showDecodeError(msg) {
    log("decodificador:", msg);
    var now = Date.now();
    if (now - lastErrTs > 1000) {
      lastErrTs = now;
      hintCtx.textContent = "Error de audio: " + msg;
    }
  }
  function setPlaying(p) {
    playing = p;
    playBtn.classList.toggle("playing", p);
    playLabel.textContent = p ? "ACTIVO" : "ESCUCHAR";
    hintCtx.textContent = p ? "Escuchando audio del PC - WS/Opus" : "Toca para escuchar el audio del PC";
    playIcon.innerHTML = p
      ? '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: "WasapiSink", artist: "PC Loopback" });
      navigator.mediaSession.playbackState = "playing";
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", function () { if (playing) toggle(); });
    } catch (e) { }
  }
  function clearMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; } catch (e) { }
  }

  function schedulePcm(channelData, frames, sr) {
    var ch = channelData.length;
    var buf = audioCtx.createBuffer(ch, frames, sr);
    for (var c = 0; c < ch; c++) {
      buf.getChannelData(c).set(channelData[c].subarray(0, frames));
    }

    var now = audioCtx.currentTime;
    if (nextStart < now + TARGET_BUF_S) nextStart = now + TARGET_BUF_S;  // underrun/restart
    if (nextStart > now + MAX_AHEAD_S) nextStart = now + TARGET_BUF_S;   // vuelta de background
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNode);
    src.start(nextStart);
    nextStart += frames / sr;
  }

  function initAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = muted ? 0 : 1;
    gainNode.connect(audioCtx.destination);
    nextStart = 0;
    lastSeq = -1;

    opusDecoder = new window["opus-decoder"].OpusDecoder();
    return opusDecoder.ready;
  }
  function freeAudio() {
    if (opusDecoder) { try { opusDecoder.free(); } catch (e) { } opusDecoder = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) { } audioCtx = null; }
    gainNode = null;
  }

  function onFrame(data) {
    if (!data || data.byteLength < 8 || !opusDecoder) return;
    var v = new DataView(data);
    var seq = v.getUint32(0, false);
    var opus = new Uint8Array(data, 8);
    lastFrameTs = Date.now();
    if (lastSeq !== -1 && seq > lastSeq + 1) {
      log("hueco seq: " + (lastSeq + 1) + ".." + (seq - 1));
    }
    lastSeq = seq;
    var out;
    try {
      out = opusDecoder.decodeFrame(opus);
    } catch (e) {
      showDecodeError(e && e.message ? e.message : String(e));
      return;
    }
    if (out.errors && out.errors.length) {
      showDecodeError(out.errors[0].message);
    }
    if (!out.samplesDecoded || !out.channelData || !out.channelData.length) return;
    schedulePcm(out.channelData, out.samplesDecoded, out.sampleRate);
  }

  function connect() {
    ws = new WebSocket("ws://" + location.hostname + ":" + WS_PORT);
    ws.binaryType = "arraybuffer";
    setBadge("conectando...", "recon");

    ws.onopen = function () {
      setBadge("Conectado", "live");
      log("WS conectado");
      reconnectAttempts = 0;
      lastFrameTs = Date.now();
    };
    ws.onmessage = function (ev) { onFrame(ev.data); };
    ws.onerror = function () { };
    ws.onclose = function () {
      log("WS cerrado");
      setBadge("recon...", "recon");
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var d = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      // ponytail: decoder sobrevive al reconnect (resincroniza solo); solo se recrea al togglear.
      if (playing) connect();
    }, d);
  }

  function toggle() {
    try { navigator.vibrate(10); } catch (e) { }
    if (playing) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.onclose = null; try { ws.close(); } catch (e) { } ws = null; }
      freeAudio();
      clearMediaSession();
      setPlaying(false);
      setBadge("Desconectado", "off");
      return;
    }
    setPlaying(true);
    setupMediaSession();
    setBadge("cargando decoder...", "recon");
    initAudio().then(function () {
      if (playing) connect();
    }).catch(function (e) {
      log("decoder no listo:", e);
      setBadge("error decoder", "off");
      setPlaying(false);
    });
  }

  // Mute local (gain a 0); preserva sesion via gain node
  function updateMute(m) {
    muted = m;
    if (gainNode) gainNode.gain.value = m ? 0 : 1;
    muteBtn.classList.toggle("active-warn", m);
    muteBtn.setAttribute("aria-pressed", String(m));
    muteLabel.textContent = m ? "Silenciado" : "Silenciar";
    muteIcon.innerHTML = m
      ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>'
      : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
  }
  if (muteBtn) muteBtn.addEventListener("click", function () { try { navigator.vibrate(10); } catch (e) { } updateMute(!muted); });

  if (mediaKeyBtn) mediaKeyBtn.addEventListener("click", function () {
    if (mediaKeyBtn.disabled) return;
    try { navigator.vibrate([10, 30, 10]); } catch (e) { }
    mediaKeyBtn.disabled = true;
    mediaKeyBtn.classList.add("pulse-amber");
    fetch("/api/pc/media-key", { method: "POST" })
      .catch(function () { log("media-key fallo"); })
      .finally(function () {
        setTimeout(function () {
          mediaKeyBtn.classList.remove("pulse-amber");
          mediaKeyBtn.disabled = false;
        }, 220);
      });
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && playing && audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  });

  playBtn.addEventListener("click", toggle);
  setBadge("Desconectado", "off");
})();
