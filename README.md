# Sink

Audio sobre IP en LAN: captura lo que suena en tu PC (WASAPI loopback)
y lo envía como Opus por WebSocket a un cliente — navegador o app Android
nativa — sin cables.

## Qué hace

- Captura el audio del dispositivo de salida por defecto de Windows
  (loopback, sin micrófono virtual) en un núcleo nativo Rust.
- Lo codifica en Opus 48 kHz stereo (~96 kbps, con FEC) y lo publica en
  un WebSocket binario (`ws://<ip>:8090`).
- Aun no funciona el cliente web estático, solo el aplicativo movil.

## Componentes

- `pywebrtcsink_core/` — motor Rust (PyO3): WASAPI loopback → ring buffer
  → encoder Opus → servidor WS con broadcast y backpressure drop-tail
  (cola de 3 frames por cliente). Build: `maturin develop --release`.
- `start.py` — arranque todo-en-uno (stdlib): motor + `http.server` con
  `static/` y `POST /api/pc/media-key` (tecla Play/Pause vía ctypes).
- `android/` — cliente nativo (Kotlin/Compose): WebSocket → Concentus
  (decoder Opus) → `AudioTrack` low-latency. Foreground Service con
  WakeLock + WifiLock `FULL_LOW_LATENCY` para pantalla apagada.
- `static/` — cliente web (WS + WebCodecs).

## Protocolo WS

Un frame binario por paquete Opus: `[seq:u32BE][ts:u32BE][payload opus]`.
Frames de 20 ms (960 muestras/canal @ 48 kHz). `ts` avanza de 960 en 960.

## Endpoints HTTP (:8080)

- `GET /` — cliente web estático.
- `POST /api/pc/media-key` — emula la tecla multimedia Play/Pause en Windows.
