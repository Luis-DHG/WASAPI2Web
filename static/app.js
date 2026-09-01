/* app.js — cliente WS+WebCodecs para el motor Rust (pywebrtcsink-core).
 *
 * Flujo:
 *   1. WS a ws://<host>:8090 — frames binarios [seq:u32BE | ts:u32BE | opus].
 *   2. WebCodecs AudioDecoder('opus') -> AudioData f32-planar 48kHz estereo.
 *   3. Scheduler sobre AudioContext: buffer 60ms objetivo, encola AudioBufferSource
 *      por frame (PLC de Opus cubre los huecos seq-jumps tras tcp drop-tail).
 *   4. MediaSession + mute ganador local (gain node).
 */
(function () {
  "use strict";

  if (!window.AudioDecoder) {
    document.getElementById("hintCtx").textContent =
      "Este navegador no soporta WebCodecs (usá Chrome/Edge/Brave).";
    return;
  }

  var $ = function (id) { return document.getElementById(id); };
  var playBtn = $("playBtn"), playLabel = $("playLabel"), playIcon = $("playIcon"),
      hintCtx = $("hintCtx"), wsBadge = $("wsBadge"),
      muteBtn = $("muteBtn"), muteIcon = $("muteIcon"), muteLabel = $("muteLabel"),
      mediaKeyBtn = $("mediaKeyBtn");

  var WS_PORT = 8090;
  var TARGET_BUF_S = 0.06;         // 60ms de jitter buffer (3 frames de 20ms)
  var RECONNECT_BASE_MS = 500, RECONNECT_MAX_MS = 5000;

  var playing = false, muted = false;
  var ws = null, audioCtx = null, gainNode = null, decoder = null;
  var nextStart = 0;               // reloj de scheduling
  var lastFrameTs = 0;             // watchdog simple del stream
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
      navigator.mediaSession.metadata = new MediaMetadata({ title: "PyWebRTCSink", artist: "PC Loopback" });
      navigator.mediaSession.playbackState = "playing";
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", function () { if (playing) toggle(); });
    } catch (e) {}
  }
  function clearMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; } catch (e) {}
  }

  function scheduleSource(ad) {
    // ponytail: 1 fuente por frame; frame=960 muestras = 20ms. Sin resampler manual.
    var frames = ad.numberOfFrames, ch = ad.numberOfChannels, sr = ad.sampleRate;
    var buf = audioCtx.createBuffer(ch, frames, sr);
    var plane = new Float32Array(frames);
    for (var c = 0; c < ch; c++) {
      ad.copyTo(plane, { planeIndex: c });
      buf.getChannelData(c).set(plane);
    }
    ad.close();

    var now = audioCtx.currentTime;
    if (nextStart < now + TARGET_BUF_S) nextStart = now + TARGET_BUF_S;  // underrun/restart
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

    decoder = new AudioDecoder({
      output: scheduleSource,
      error: function (e) { log("decodificador:", e.message); },
    });
    decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
  }

  function onFrame(data) {
    var v = new DataView(data);
    var seq = v.getUint32(0, false);
    var ts = v.getUint32(4, false);
    var opus = new Uint8Array(data, 8);
    lastFrameTs = Date.now();
    // ponytail: seq guardado solo para detectar huecos (PLC llena solo en el decoder).
    window.__lastSeq = seq;
    decoder.decode(new EncodedAudioChunk({
      type: "key",
      timestamp: (ts / 48000) * 1e6,   // us
      data: opus,
    }));
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
    ws.onerror = function () {};
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
      if (playing) { if (decoder) decoder.close(); initAudio(); connect(); }
    }, d);
  }

  function toggle() {
    try { navigator.vibrate(10); } catch (e) {}
    if (playing) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; }
      if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
      clearMediaSession();
      setPlaying(false);
      setBadge("Desconectado", "off");
      return;
    }
    setPlaying(true);
    setupMediaSession();
    initAudio();
    connect();
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
  if (muteBtn) muteBtn.addEventListener("click", function () { try { navigator.vibrate(10); } catch (e) {} updateMute(!muted); });

  if (mediaKeyBtn) mediaKeyBtn.addEventListener("click", function () {
    if (mediaKeyBtn.disabled) return;
    try { navigator.vibrate([10, 30, 10]); } catch (e) {}
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
