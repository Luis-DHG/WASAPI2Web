package com.wasapi.sink.webrtc

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SignallingClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .build()
) {
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun postOffer(serverUrl: String, sdp: String, type: String = "offer"): Result<Pair<String, String>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val baseUrl = serverUrl.trimEnd('/')
                val bodyJson = JSONObject().apply {
                    put("sdp", sdp)
                    put("type", type)
                }
                val request = Request.Builder()
                    .url("$baseUrl/offer")
                    .post(bodyJson.toString().toRequestBody(jsonMediaType))
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        val err = response.body?.string() ?: ""
                        throw RuntimeException("HTTP ${response.code}: $err")
                    }
                    val respStr = response.body?.string() ?: throw RuntimeException("Respuesta vacía del servidor")
                    val json = JSONObject(respStr)
                    val answerSdp = json.getString("sdp")
                    val answerType = json.optString("type", "answer")
                    Pair(answerSdp, answerType)
                }
            }
        }

    suspend fun sendMediaKey(serverUrl: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val baseUrl = serverUrl.trimEnd('/')
                val request = Request.Builder()
                    .url("$baseUrl/api/pc/media-key")
                    .post("{}".toRequestBody(jsonMediaType))
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw RuntimeException("HTTP ${response.code}")
                    }
                }
            }
        }
}
