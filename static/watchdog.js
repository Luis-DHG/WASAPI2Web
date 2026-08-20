// RtpSilenceWatchdog — spec compartida browser+Android.
// Deltas de packetsReceived -> callback onSilence cuando el stream lleva
// > silenceMs sin paquetes nuevos. Umbral/intervalo en un solo sitio.
// Ponytail: gemelo en android/.../WebRtcManager.kt:202 usa misma spec
// (3000ms / 10000ms). Si tocas los defaults aca, hazlo alla tambien.

export function createRtpSilenceWatchdog({ intervalMs = 3000, silenceMs = 10000, onSilence } = {}) {
  let lastPackets = -1;
  let lastPacketTs = 0;
  let timer = null;

  // Decision pura: snapshot de packetsReceived + now -> onSilence si carry.
  function observe(packetsNow, now = Date.now()) {
    if (packetsNow < 0) return;
    if (packetsNow > lastPackets && lastPackets >= 0) lastPacketTs = now;
    lastPackets = packetsNow;
    if (lastPacketTs > 0 && now - lastPacketTs > silenceMs) onSilence();
  }

  function prime(now = Date.now()) {
    lastPackets = -1;
    lastPacketTs = now;
  }

  function start(getPackets, isAlive = () => true) {
    stop();
    lastPackets = -1;
    lastPacketTs = 0;
    timer = setInterval(async () => {
      if (!isAlive()) return;
      let packetsNow = -1;
      try {
        const stats = await getPackets();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            packetsNow = report.packetsReceived || 0;
          }
        });
      } catch (e) { return; }
      observe(packetsNow);
    }, intervalMs);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, prime, observe };
}
