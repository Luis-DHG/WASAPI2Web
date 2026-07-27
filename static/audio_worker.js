/* audio_worker.js - PyAudioBridge Dedicated Web Worker.
 *
 * Responsabilidades:
 *   1. Ciclo de vida del WebSocket en hilo independiente ( fuera del Main Thread ).
 *   2. Desempaquetado de la cabecera de handshake ( 24B "PYAB" + rate/ch/sw/codec/hdr ).
 *   3. Desempaquetado de cabecera de bloque ( 8B: uint32 ts_ms + uint32 flags ).
 *   4. Conversion Int16 LE -> Float32 ( uno o dos canales ).
 *   5. Jitter buffer ordenado por ts_ms ( tap 30 bloques ).
 *   6. Transferencia zero-copy al Main Thread via Transferable ArrayBuffer.
 *   7. Ping/pong texto cada 3s para medir RTT y mantener NAT vivo.
 *
 * No toca AudioContext ( Web Audio solo vive en Main Thread ).
 */
(function () {
  "use strict";

  // ---- Config ----
  const PING_INTERVAL_MS = 3000;
  const JITTER_MAX_BLOCKS = 30;

  // ---- Estado ----
  let ws = null;
  let connected = false;
  let headerParsed = false;
  let fmt = { rate: 48000, channels: 2, sw: 2, hdrBytes: 8, codec: 0 };
  let blockDurMs = 0;
  let lastTsMs = 0;
  let jitterBuffer = [];        // array de { ts, left, right }
  let underruns = 0;
  let blocksLost = 0;
  let pingTimer = null;
  let pendingPongs = [];
  let rttMs = 0;

  // ---- Entrada desde Main Thread ----
  self.onmessage = function (e) {
    const cmd = e.data ? e.data.cmd : null;
    if (cmd === "start") start(e.data.url);
    else if (cmd === "stop") stop();
    else if (cmd === "ping") sendText("ping");
    else if (cmd === "flush") jitterBuffer.length = 0;
  };

  // ---- Ciclo de vida WS ----
  function start(url) {
    stopInternal();
    headerParsed = false;
    jitterBuffer.length = 0;
    pendingPongs.length = 0;
    lastTsMs = 0;
    blockDurMs = 0;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      self.postMessage({ t: "error", err: String(err) });
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = onOpen;
    ws.onmessage = onMessage;
    ws.onclose = onClose;
    ws.onerror = function (x) {
      self.postMessage({ t: "error", err: String(x && x.message ? x.message : x) });
    };
  }

  function stop() {
    stopInternal();
    self.postMessage({ t: "stopped" });
  }

  function stopInternal() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ws) {
      try { ws.onclose = null; ws.onmessage = null; ws.onopen = null; } catch (e) {}
      try { ws.close(); } catch (e) {}
      ws = null;
    }
    connected = false;
  }

  // ---- Eventos WS ----
  function onOpen() {
    connected = true;
    self.postMessage({ t: "open" });
    pingTimer = setInterval(function () {
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
      pendingPongs.push(Date.now());
      sendText("ping");
    }, PING_INTERVAL_MS);
  }

  function onMessage(ev) {
    if (typeof ev.data === "string") {
      handleText(ev.data);
      return;
    }
    handleBinary(ev.data);
  }

  function onClose(ev) {
    connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    pendingPongs.length = 0;
    self.postMessage({ t: "close", code: ev.code, reason: ev.reason });
  }

  // ---- Texto (pong / device:/level:/flush ack) ----
  function handleText(text) {
    if (text === "pong") {
      if (pendingPongs.length) {
        rttMs = Date.now() - pendingPongs.shift();
        self.postMessage({ t: "rtt", ms: rttMs });
      }
      return;
    }
    if (text.startsWith("device:")) {
      self.postMessage({ t: "device", name: text.slice(7).trim() });
      return;
    }
    // "level:" y otros: ignorar en worker (UI minimalista, sin nivel RMS).
  }

  // ---- Binario ----
  function handleBinary(buf) {
    if (!headerParsed) {
      if (buf.byteLength >= 24) {
        const v = new DataView(buf);
        const magic = String.fromCharCode(
          v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)
        );
        if (magic === "PYAB") {
          fmt.rate = v.getUint32(4, true);
          fmt.channels = v.getUint32(8, true);
          fmt.sw = v.getUint32(12, true);
          fmt.codec = v.getUint32(16, true);
          fmt.hdrBytes = v.getUint32(20, true);
          headerParsed = true;
          self.postMessage({
            t: "format",
            fmt: {
              rate: fmt.rate,
              channels: fmt.channels,
              sw: fmt.sw,
              codec: fmt.codec,
              hdrBytes: fmt.hdrBytes,
            },
          });
          return;
        }
      }
      return;
    }
    handleAudioBlock(buf);
  }

  function handleAudioBlock(buf) {
    if (buf.byteLength < fmt.hdrBytes) return;
    const v = new DataView(buf);
    const tsMs = v.getUint32(0, true);
    const flags = v.getUint32(4, true);     // reservado
    const payloadBytes = buf.byteLength - fmt.hdrBytes;

    // Bloque de silencio (payload 0): avisar para realinear scheduler.
    if (payloadBytes === 0) {
      self.postMessage({ t: "silence", ts: tsMs, durMs: blockDurMs });
      return;
    }

    // Vista Int16 LE sobre el payload (sin copia).
    const int16 = new Int16Array(buf, fmt.hdrBytes, payloadBytes / 2);
    const frames = Math.floor(int16.length / fmt.channels);
    if (frames === 0) return;

    // Deteccion de perdida simple por salto de ts_ms.
    if (lastTsMs > 0) {
      const expected = lastTsMs + blockDurMs;
      const gap = tsMs - expected;
      if (gap > 5 && gap < 5000) {
        // Hueco inesperado: probable bloque perdido.
        blocksLost++;
        self.postMessage({ t: "lost", n: 1, total: blocksLost });
      }
    }

    // Decode Int16 -> Float32, deinterleave si stereo.
    const left = new Float32Array(frames);
    const right = fmt.channels > 1 ? new Float32Array(frames) : null;
    if (fmt.channels === 1) {
      for (let i = 0; i < frames; i++) left[i] = int16[i] / 32768;
    } else {
      for (let i = 0; i < frames; i++) {
        left[i] = int16[i * 2] / 32768;
        right[i] = int16[i * 2 + 1] / 32768;
      }
    }

    // Jitter buffer: append + sort por ts_ms + cap.
    jitterBuffer.push({ ts: tsMs, left: left, right: right });
    if (jitterBuffer.length > 1) {
      jitterBuffer.sort(function (a, b) { return a.ts - b.ts; });
    }
    if (jitterBuffer.length > JITTER_MAX_BLOCKS) {
      jitterBuffer.shift();
    }

    // Push al Main Thread con transferencia zero-copy.
    const transfer = [left.buffer];
    if (right) transfer.push(right.buffer);
    self.postMessage(
      { t: "audio", left: left, right: right, frames: frames, ts: tsMs, flags: flags },
      transfer
    );

    blockDurMs = (frames / fmt.rate) * 1000;
    lastTsMs = tsMs;
  }

  // ---- Utilidades ----
  function sendText(text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(text); } catch (e) {}
    }
  }

  // Exponer para debug (opcional).
  self.PyABWorker = {
    get connected() { return connected; },
    get fmt() { return fmt; },
    get jitterLen() { return jitterBuffer.length; },
    get rttMs() { return rttMs; },
  };
})();
