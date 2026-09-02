package com.wasapi.sink.ui

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.VolumeMute
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wasapi.sink.service.AudioForegroundService
import com.wasapi.sink.service.ConnectionState
import com.wasapi.sink.service.ServiceUiState
import com.wasapi.sink.ui.theme.AccentCyan
import com.wasapi.sink.ui.theme.AmberWarn
import com.wasapi.sink.ui.theme.AmberWarnBg
import com.wasapi.sink.ui.theme.AmberWarnLight
import com.wasapi.sink.ui.theme.BgDark
import com.wasapi.sink.ui.theme.CardBg
import com.wasapi.sink.ui.theme.CardBorder
import com.wasapi.sink.ui.theme.DangerRed
import com.wasapi.sink.ui.theme.DangerRedBg
import com.wasapi.sink.ui.theme.DangerRedLight
import com.wasapi.sink.ui.theme.FgLight
import com.wasapi.sink.ui.theme.FgMuted
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    uiState: ServiceUiState,
    initialServerUrl: String?,
    onServerUrlChanged: (String) -> Unit,
    onRequestNotificationPermission: (() -> Unit)? = null
) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()

    var serverUrlInput by remember(initialServerUrl) { mutableStateOf(initialServerUrl ?: "") }
    var mediaKeyPulsing by remember { mutableStateOf(false) }

    // B3: debounce URL changes — solo dispara onServerUrlChanged despues de 400ms sin teclear
    LaunchedEffect(serverUrlInput) {
        delay(400)
        if (serverUrlInput.isNotBlank()) onServerUrlChanged(serverUrlInput)
    }

    val isConnected = uiState.connectionState == ConnectionState.CONNECTED
    val isControlsEnabled = uiState.isPlaying && isConnected

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDark)
            .padding(horizontal = 18.dp, vertical = 20.dp)
    ) {
        val isLandscape = maxHeight < 500.dp
        val playBtnSize: Dp = if (isLandscape) 150.dp else 210.dp
        val playLabel = if (uiState.isPlaying) "Detener stream" else "Escuchar audio del PC"

        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Header: Titulo + Badge
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "PyWebRTCSink",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    color = FgLight.copy(alpha = 0.6f),
                    letterSpacing = (-0.02).sp
                )

                StatusBadge(uiState.connectionState)
            }

            Spacer(modifier = Modifier.height(10.dp))

            // URL del Servidor
            OutlinedTextField(
                value = serverUrlInput,
                onValueChange = { serverUrlInput = it },
                label = { Text("URL del Servidor", color = FgMuted, fontSize = 12.sp) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Done
                ),
                keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() }),
                colors = TextFieldDefaults.outlinedTextFieldColors(
                    focusedTextColor = FgLight,
                    unfocusedTextColor = FgLight,
                    focusedBorderColor = AccentCyan,
                    unfocusedBorderColor = CardBorder,
                    containerColor = CardBg,
                    cursorColor = AccentCyan
                ),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp)
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Main Circular Play Button — B4: ripple restaurado, A1: semantics role=Button
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(playBtnSize)
                        .clip(CircleShape)
                        .background(if (uiState.isPlaying) AccentCyan else Color.Transparent)
                        .border(BorderStroke(2.dp, AccentCyan), CircleShape)
                        .semantics {
                            role = Role.Button
                            contentDescription = playLabel
                            stateDescription = if (uiState.isPlaying) "Activo" else "Detenido"
                        }
                        .clickable(
                            onClickLabel = playLabel
                        ) {
                            triggerHaptic(context, 10L)
                            if (uiState.isPlaying) {
                                AudioForegroundService.stop(context)
                            } else {
                                onRequestNotificationPermission?.invoke()
                                AudioForegroundService.start(context, serverUrlInput)
                            }
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Icon(
                            imageVector = if (uiState.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                            contentDescription = null,
                            tint = if (uiState.isPlaying) BgDark else AccentCyan,
                            modifier = Modifier.size(if (isLandscape) 42.dp else 56.dp)
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = if (uiState.isPlaying) "ACTIVO" else "ESCUCHAR",
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = 0.5.sp,
                            color = if (uiState.isPlaying) BgDark else AccentCyan
                        )
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                Text(
                    text = when {
                        uiState.isPlaying && isConnected -> "Escuchando audio del PC · WebRTC"
                        uiState.isPlaying -> "Conectando al stream de audio..."
                        else -> "Toca para escuchar el audio del PC"
                    },
                    fontSize = 13.sp,
                    color = FgMuted,
                    textAlign = TextAlign.Center
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Controles Secundarios: Mute + Media Key
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                ControlButton(
                    text = if (uiState.isMuted) "Silenciado" else "Silenciar",
                    icon = if (uiState.isMuted) Icons.Default.VolumeMute else Icons.Default.VolumeUp,
                    isActive = uiState.isMuted,
                    activeBg = DangerRedBg,
                    activeBorder = DangerRed,
                    activeFg = DangerRedLight,
                    enabled = isControlsEnabled,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        triggerHaptic(context, 10L)
                        AudioForegroundService.toggleMute(context)
                    }
                )

                // Media Key PC: acción momentánea (no toggle), pulse ámbar
                val mediaKeyBg by animateColorAsState(
                    targetValue = if (mediaKeyPulsing) AmberWarnBg else CardBg,
                    animationSpec = tween(durationMillis = 200),
                    label = "mediaKeyBg"
                )
                val mediaKeyBorder by animateColorAsState(
                    targetValue = if (mediaKeyPulsing) AmberWarn else CardBorder,
                    animationSpec = tween(durationMillis = 200),
                    label = "mediaKeyBorder"
                )

                ControlButton(
                    text = "Play/Pause PC",
                    icon = Icons.Default.PlayArrow,
                    isActive = false,
                    customBg = mediaKeyBg,
                    customBorder = mediaKeyBorder,
                    enabled = isControlsEnabled && !mediaKeyPulsing,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        triggerHaptic(context, timings = longArrayOf(0, 10, 30, 10))
                        mediaKeyPulsing = true
                        AudioForegroundService.sendMediaKey(context)
                        scope.launch {
                            delay(220)
                            mediaKeyPulsing = false
                        }
                    }
                )
            }
        }
    }
}

@Composable
fun StatusBadge(state: ConnectionState) {
    val (text, color, bg) = when (state) {
        ConnectionState.CONNECTED -> Triple("Conectado", AccentCyan, AccentCyan.copy(alpha = 0.1f))
        ConnectionState.CONNECTING -> Triple("conectando...", AmberWarn, AmberWarn.copy(alpha = 0.1f))
        ConnectionState.RECONNECTING -> Triple("re-conectando...", AmberWarn, AmberWarn.copy(alpha = 0.1f))
        ConnectionState.ERROR -> Triple("error", DangerRed, DangerRed.copy(alpha = 0.1f))
        ConnectionState.DISCONNECTED -> Triple("Desconectado", DangerRed, DangerRed.copy(alpha = 0.1f))
    }

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .border(BorderStroke(1.dp, color.copy(alpha = 0.4f)), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 3.dp)
    ) {
        Text(
            text = text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = color
        )
    }
}

// A2-A3: semantics role=Button, stateDescription, contentDescription del icono
@Composable
fun ControlButton(
    text: String,
    icon: ImageVector,
    isActive: Boolean,
    modifier: Modifier = Modifier,
    activeBg: Color = DangerRedBg,
    activeBorder: Color = DangerRed,
    activeFg: Color = DangerRedLight,
    customBg: Color? = null,
    customBorder: Color? = null,
    enabled: Boolean = true,
    onClick: () -> Unit
) {
    val bg = customBg ?: if (isActive) activeBg else CardBg
    val border = customBorder ?: if (isActive) activeBorder else CardBorder
    val fg = if (isActive) activeFg else FgLight

    val alpha = if (enabled) 1.0f else 0.4f

    Box(
        modifier = modifier
            .height(48.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(bg.copy(alpha = bg.alpha * alpha))
            .border(BorderStroke(1.dp, border.copy(alpha = border.alpha * alpha)), RoundedCornerShape(12.dp))
            .semantics {
                role = Role.Button
                contentDescription = text
                stateDescription = if (isActive) "Activado" else "Desactivado"
            }
            .clickable(enabled = enabled, onClickLabel = text, onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            Icon(
                imageVector = icon,
                contentDescription = text,
                tint = fg.copy(alpha = alpha),
                modifier = Modifier.size(18.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = text,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = fg.copy(alpha = alpha)
            )
        }
    }
}

fun triggerHaptic(context: Context, durationMs: Long = 10L, timings: LongArray? = null) {
    try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            val vibrator = vibratorManager?.defaultVibrator ?: return
            if (timings != null) {
                vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
            } else {
                vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
            }
        } else {
            @Suppress("DEPRECATION")
            val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (timings != null) {
                    vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
                } else {
                    vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
                }
            } else {
                @Suppress("DEPRECATION")
                if (timings != null) {
                    vibrator.vibrate(timings, -1)
                } else {
                    vibrator.vibrate(durationMs)
                }
            }
        }
    } catch (_: Exception) {}
}
