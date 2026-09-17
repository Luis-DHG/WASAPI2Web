# Sink

Audio sobre IP en LAN: captura lo que suena en tu PC (WASAPI loopback)
y lo envía como Opus por WebSocket a un cliente — navegador o app Android
nativa — sin cables.

## Qué hace

- Captura el audio del dispositivo de salida por defecto de Windows
  (loopback, sin micrófono virtual) en un núcleo nativo Rust.
- Lo codifica en Opus 48 kHz stereo (~96 kbps, con FEC) y lo publica en
  un WebSocket binario (`ws://<ip>:8090`).
- Se escucha desde el navegador (`http://<ip>:8080`) o la app Android.

## Componentes

- `pywebrtcsink_core/` — motor Rust (PyO3): WASAPI loopback → ring buffer
  → encoder Opus → servidor WS con broadcast y backpressure drop-tail
  (cola de 3 frames por cliente). Build: `maturin develop --release`.
- `start.py` — arranque todo-en-uno (stdlib): motor + `http.server` con
  `static/` y `POST /api/pc/media-key` (tecla Play/Pause vía ctypes).
- `android/` — cliente nativo (Kotlin/Compose): WebSocket → Concentus
  (decoder Opus) → `AudioTrack` low-latency. Foreground Service con
  WakeLock + WifiLock `FULL_LOW_LATENCY` para pantalla apagada.
- `static/` — cliente web (WS + decoder Opus WASM vendoreado,
  funciona en Chrome/Edge/Firefox/Safari sin WebCodecs).

## Probar el cliente web

1. En el PC: `python start.py` (anota la IP que imprime, ej. `192.168.1.10`).
2. En el móvil (misma WiFi): abrir `http://192.168.1.10:8080`.
3. Tocar **ESCUCHAR**. Si hay error de audio, el hint bajo el botón
   muestra el motivo (además de la consola del navegador).

Notas:

- El decoder es `opus-decoder` (WASM, MIT) vendoreado en
  `static/vendor/opus-decoder.min.js` (v0.7.12, single-file, sin
  toolchain). Para actualizarlo: `npm pack opus-decoder` y copiar
  `package/dist/opus-decoder.min.js` a `static/vendor/`.

## Protocolo WS

Un frame binario por paquete Opus: `[seq:u32BE][ts:u32BE][payload opus]`.
Frames de 20 ms (960 muestras/canal @ 48 kHz). `ts` avanza de 960 en 960.

## Endpoints HTTP (:8080)

- `GET /` — cliente web estático.
- `POST /api/pc/media-key` — emula la tecla multimedia Play/Pause en Windows.
