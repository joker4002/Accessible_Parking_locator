package com.kingstonaccess.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class DirectionsPolylineResult(
    val overviewPoints: String?,
    val stepPoints: List<String>
)

class HttpDirectionsRepository {

    suspend fun getPolylineResult(
        originLat: Double,
        originLng: Double,
        destinationLat: Double,
        destinationLng: Double,
        apiKey: String,
        mode: String = "driving"
    ): DirectionsPolylineResult = withContext(Dispatchers.IO) {
        val key = apiKey.trim()
        if (key.isBlank() || key == "YOUR_API_KEY") {
            return@withContext DirectionsPolylineResult(overviewPoints = null, stepPoints = emptyList())
        }

        fun empty(): DirectionsPolylineResult {
            return DirectionsPolylineResult(overviewPoints = null, stepPoints = emptyList())
        }

        val url = URL(
            "https://maps.googleapis.com/maps/api/directions/json" +
                "?origin=${originLat},${originLng}" +
                "&destination=${destinationLat},${destinationLng}" +
                "&mode=${encode(mode)}" +
                "&overview=full" +
                "&alternatives=false" +
                "&region=ca" +
                "&key=${encode(key)}"
        )

        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10000
            readTimeout = 10000
        }

        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream.bufferedReader().use(BufferedReader::readText)

            if (code !in 200..299) {
                throw IllegalStateException("HTTP $code: $body")
            }

            val root = JSONObject(body)
            val status = root.optString("status").trim()
            if (status.isNotBlank() && status != "OK") {
                val msg = root.optString("error_message").trim()
                val tail = if (msg.isNotBlank()) ": $msg" else ""
                throw IllegalStateException("Directions $status$tail")
            }

            val routes = root.optJSONArray("routes") ?: return@withContext empty()
            if (routes.length() == 0) return@withContext empty()

            val route0 = routes.optJSONObject(0) ?: return@withContext empty()
            val overview = route0.optJSONObject("overview_polyline")
            val overviewPoints = overview.optString("points").trim().ifBlank { null }

            val stepsOut = buildList {
                val legs = route0.optJSONArray("legs")
                val leg0 = legs?.optJSONObject(0)
                val steps = leg0?.optJSONArray("steps")
                if (steps != null) {
                    for (i in 0 until steps.length()) {
                        val step = steps.optJSONObject(i) ?: continue
                        val poly = step.optJSONObject("polyline") ?: continue
                        val pts = poly.optString("points").trim()
                        if (pts.isNotBlank()) add(pts)
                    }
                }
            }

            DirectionsPolylineResult(
                overviewPoints = overviewPoints,
                stepPoints = stepsOut
            )
        } finally {
            conn.disconnect()
        }
    }
}

private fun encode(s: String): String = URLEncoder.encode(s, "UTF-8")
