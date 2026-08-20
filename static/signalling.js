// Signalling — adapter HTTP del browser para POST /offer y POST /api/pc/media-key.
// Paridad con android/.../SignallingClient.kt (postOffer + sendMediaKey).

export async function postOffer(localDescription) {
  const resp = await fetch("/offer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sdp: localDescription.sdp, type: localDescription.type }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("/offer HTTP " + resp.status + ": " + err);
  }
  return resp.json();
}

export async function postMediaKey() {
  const resp = await fetch("/api/pc/media-key", { method: "POST" });
  if (!resp.ok) throw new Error("/api/pc/media-key HTTP " + resp.status);
}
