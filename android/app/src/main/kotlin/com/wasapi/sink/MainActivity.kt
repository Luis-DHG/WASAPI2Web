package com.wasapi.sink

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import com.wasapi.sink.service.AudioForegroundService
import com.wasapi.sink.ui.HomeScreen
import com.wasapi.sink.ui.theme.PyWebRTCSinkTheme

class MainActivity : ComponentActivity() {

    private val prefs: SharedPreferences by lazy {
        getSharedPreferences(AudioForegroundService.PREFERENCES_NAME, Context.MODE_PRIVATE)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val savedUrl = prefs.getString(AudioForegroundService.PREFERENCE_SERVER_URL, null)

        setContent {
            PyWebRTCSinkTheme {
                val uiState by AudioForegroundService.uiState.collectAsState()

                val notificationPermissionLauncher = rememberLauncherForActivityResult(
                    contract = ActivityResultContracts.RequestPermission()
                ) { /* no-op */ }

                HomeScreen(
                    uiState = uiState,
                    initialServerUrl = savedUrl,
                    onServerUrlChanged = { newUrl ->
                        prefs.edit().putString(AudioForegroundService.PREFERENCE_SERVER_URL, newUrl).apply()
                    },
                    onRequestNotificationPermission = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            if (ContextCompat.checkSelfPermission(
                                    this@MainActivity,
                                    Manifest.permission.POST_NOTIFICATIONS
                                ) != PackageManager.PERMISSION_GRANTED
                            ) {
                                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                        }
                    }
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        AudioForegroundService.notifyAppForeground(this)
    }
}
