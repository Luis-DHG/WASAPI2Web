# PyAudioBridge

Puente WASAPI Loopback → WebSocket → Web Audio API. Transmite audio del sistema Windows en tiempo real al navegador movil via TCP.

```
PC (WASAPI) ──► Python captura ──► WebSocket ──► Android Chrome ──► Web Audio API
```

## Uso

```powershell
python src\server.py
```

El servidor muestra:

```
IP local: 192.168.X.X
Abre desde el movil: http://192.168.X.X:8080
WebSocket:           ws://192.168.X.X:8080/ws
```

Abre `http://192.168.X.X:8080` en el navegador Android. Presiona el boton central **INICIAR** para activar AudioContext (politica autoplay) y comenzar a escuchar.

## Firewall de Windows

Para permitir conexiones desde la LAN:

**Opcion A — PowerShell (Admin):**
```powershell
New-NetFirewallRule -DisplayName "PyAudioBridge 8080" -Direction Inbound `
  -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private,Domain
```

> **Seguridad:** La regla permite solo desde redes Privada/Dominio (no Publica).

## Audio

### Dispositivo por defecto
PyAudioBridge captura el dispositivo WASAPI loopback por defecto (el mismo que escuchas en los altavoces/auriculares).

### Formato de audio
- PCM Int16, sample rate nativo del dispositivo (tipico 48 kHz), estereo/mono segun dispositivo
- El cliente recibe el formato real via cabecera WebSocket (4 primeros bytes: magic `PYAB`, luego rate, canales, sample_width en uint32 LE)

## Arquitectura

```
src/
  audio_capture.py   — Hebra dedicada PyAudioWPatch loopback → asyncio.Queue
  server.py          — aiohttp HTTP (static/) + WebSocket + broadcast pump
  utils.py           — resolucion IP local, helpers
static/
  index.html         — UI responsive movil
  app.js             — WebSocket + jitter buffer + Web Audio API
```

### Backpressure
- Captura descarta bloques si cola asyncio llena
- Broadcast descarga clientes lentos si acumulan >256 KiB backlog
- Client sender descarta bloques viejos si cola llena

### Jitter Buffer (cliente)
- Agenda bloques via `AudioBufferSourceNode.start()` sobre `currentTime`
- Gap minimo 20 ms anti-underrun
- Si latencia supera 500 ms, realinea al objetivo de 120 ms

## Verificacion

```powershell
python -m py_compile src\__init__.py src\utils.py src\audio_capture.py src\server.py
```

## Solucion de problemas

| Problema | Causa | Solucion |
|----------|-------|----------|
| `OSError: Invalid sample rate` | El dispositivo no soporta 44.1 kHz | Se auto-adapta al rate nativo |
| `LookupError: No loopback device` | Sin dispositivo WASAPI loopback | `python -m pyaudiowpatch` para listar |
| No se conecta desde el movil | Firewall bloquea puerto | Agregar regla Firewall (ver arriba) |
| Audio cortado / clicks | Buffer bajo o WiFi lento | El jitter buffer realinea automaticamente |
| `WebSocket desconectado` | WiFi inestable | Reconexion automatica exponencial |

## Licencia

MIT
