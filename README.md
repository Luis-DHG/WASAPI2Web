# Sink

Audio sobre IP en LAN: captura lo que suena en tu PC (WASAPI loopback)
y lo envía por WebRTC al navegador de tu móvil, sin apps ni cables.
## Qué hace

- Captura el audio del dispositivo de salida por defecto de Windows.
- Lo codifica en Opus y lo transmite via WebRTC (SRTP/UDP).
- Lo reproduce en el móvil como sesión de media real (Foreground Service
  en Android Chrome — no se congela con pantalla apagada).
- Señalización stateless vía HTTP POST /offer.

## Tecnologías

- [aiortc](https://github.com/aiortc/aiortc) — WebRTC para Python.
- [PyAV](https://github.com/PyAV-Org/PyAV) — resampleado + codec Opus.
- [PyAudioWPatch](https://github.com/s0DakkatingfenlyStakkater/PyAudioWPatch) — WASAPI loopback.
- [aiohttp](https://github.com/aio-libs/aiohttp) — HTTP server + signalling.

## Características

- **WASAPI loopback** — Captura el audio que escuchas por altavoces/auriculares,
  no requiere micrófono virtual. Sample rate nativo, resampleo a 48k automático
  si el dispositivo no está en 48k.
- **Opus 48 kHz stereo ~128 kbps con FEC** — Recupera paquetes perdidos sin
  cortes audibles en LAN/wifi inestable.
- **WebRTC SRTP/UDP** — Resistente a Doze Mode: UDP no requiere keepalive TCP
  y Android prioriza sesiones de audio reales.
- **MediaSession API + Audio Focus recovery** — El navegador registra la
  sesión como media real → Android la respeta con pantalla apagada. Si el SO
  pausa el audio (ej: llamada entrante), se reanuda solo.
- **Reconexión automática** — Backoff exponencial si ICE entra en estado
  `failed`; watchdog detecta silencio RTP y fuerza re-negociación.
- **Señalización stateless** — `POST /offer` no guarda sesiones; aiortc
  mantiene estado de cada peer en memoria.
- **Silencio y Control Remoto** —
  - **Mute local (Móvil)**: Silencia el stream sin alterar el volumen general del teléfono ni perder el Audio Focus en Android.
  - **Control multimedia de Windows**: Emula la tecla Play/Pause en Windows usando `ctypes` (sin librerías adicionales) para pausar Spotify/YouTube desde el móvil.

## Endpoints API

- `POST /offer` — Señalización WebRTC (SDP offer/answer).
- `POST /api/pc/media-key` — Emula la tecla multimedia Play/Pause en Windows.

## Instalación

```bash
git clone <repo>
cd PyWebRTCSink
pip install -r requirements.txt
python src/server.py
```

Al iniciar muestra la URL del servidor (ej: `http://192.168.x.x:8080`).
Abrela en el móvil (misma red WiFi), toca el botón ESCUCHAR.
