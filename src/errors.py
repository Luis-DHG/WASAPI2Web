"""Custom Error Classes — patrón Node.js Backend.

Jerarquía de errores tipados siguiendo el patrón AppError del skill
nodejs-backend-patterns, aplicado a Python/aiohttp.
"""

from __future__ import annotations


class AudioBridgeError(Exception):
    """Error base de la aplicación. Solo errores operacionales."""

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        details: object = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.details = details


class WSUpgradeError(AudioBridgeError):
    """La petición no es un WebSocket upgrade válido."""

    def __init__(self, message: str = "WebSocket upgrade required") -> None:
        super().__init__(message, status_code=400)


class CaptureError(AudioBridgeError):
    """Fallo en la captura WASAPI."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status_code=503)


class ClientGoneError(AudioBridgeError):
    """Cliente desconectado inesperadamente."""

    def __init__(self, client_id: int) -> None:
        super().__init__(f"Client {client_id} gone", status_code=410)