"""Demo / Test script for native WASAPI -> Opus -> WebSocket streamer."""

import sys
import time
from pywebrtcsink_core import PyWasapiSinkEngine

def main():
    engine = PyWasapiSinkEngine()
    print("==================================================================")
    print("   PyWebRTCSink — Native Rust Core (WASAPI Loopback + Opus + WS)  ")
    print("==================================================================")
    
    host = "0.0.0.0"
    port = 8765
    bitrate = 96000

    print(f"Starting native engine on ws://{host}:{port} @ {bitrate/1000:.0f} kbps...")
    try:
        engine.start(host=host, port=port, bitrate=bitrate)
    except Exception as e:
        print(f"Error starting engine: {e}")
        return

    sample_rate, channels = engine.get_device_info()
    print(f"[Audio Device] Host MixFormat: {sample_rate} Hz, {channels} Channels")
    print("Streaming live audio. Connect with a WebSocket client or web player.")
    print("Press Ctrl+C to stop.\n")

    try:
        while True:
            time.sleep(1.0)
            m = engine.get_metrics()
            print(
                f"\r[Métricas] Capturados: {m.frames_captured:8d} | "
                f"Silencio: {m.pcm_silent_injected:6d} | "
                f"Opus Encoded: {m.frames_encoded:6d} | "
                f"Enviado: {m.bytes_broadcasted / 1024:8.1f} KB | "
                f"TCP Drops: {m.frames_dropped_tcp:4d} | "
                f"Clientes: {m.active_clients:2d}",
                end="",
                flush=True,
            )
    except KeyboardInterrupt:
        print("\n\nStopping engine...")
        engine.stop()
        print("Engine stopped cleanly.")

if __name__ == "__main__":
    main()
