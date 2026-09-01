package com.wasapi.sink

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.core.content.ContextCompat
import com.wasapi.sink.service.AudioForegroundService
import com.wasapi.sink.ui.HomeScreen
import com.wasapi.sink.ui.theme.PyWebRTCSinkTheme

class MainActivity : ComponentActivity() {

    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("wasapi_sink_prefs", Context.MODE_PRIVATE)
    }

    // ponytail: URLs http://ip:port resueltas via NSD; 1 = auto-pick, >1 = lista en HomeScreen.
    private val discoveredServers = mutableStateListOf<String>()
    private var nsdManager: NsdManager? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val savedUrl = prefs.getString("server_url", null)

        setContent {
            PyWebRTCSinkTheme {
                val uiState by AudioForegroundService.uiState.collectAsState()

                val notificationPermissionLauncher = rememberLauncherForActivityResult(
                    contract = ActivityResultContracts.RequestPermission()
                ) { /* no-op */ }

                HomeScreen(
                    uiState = uiState,
                    initialServerUrl = savedUrl,
                    discoveredServers = discoveredServers,
                    onServerUrlChanged = { newUrl ->
                        prefs.edit().putString("server_url", newUrl).apply()
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

        startDiscovery()
    }

    override fun onDestroy() {
        discoveryListener?.let { runCatching { nsdManager?.stopServiceDiscovery(it) } }
        super.onDestroy()
    }

    private fun startDiscovery() {
        val nsd = getSystemService(Context.NSD_SERVICE) as NsdManager
        nsdManager = nsd
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {}
            override fun onDiscoveryStopped(regType: String) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                runCatching { nsd.stopServiceDiscovery(this) }
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                nsd.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
                    override fun onServiceResolved(resolved: NsdServiceInfo) {
                        val host = resolved.host?.hostAddress ?: return
                        val url = "http://$host:${resolved.port}"
                        runOnUiThread {
                            if (url !in discoveredServers) discoveredServers.add(url)
                        }
                    }
                })
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
        }
        discoveryListener = listener
        nsd.discoverServices("_pywrtc._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
    }
}
