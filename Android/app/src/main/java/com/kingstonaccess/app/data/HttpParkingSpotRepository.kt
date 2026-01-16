package com.kingstonaccess.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class HttpParkingSpotRepository(
    private val context: Context
) : ParkingSpotRepository {

    override suspend fun getNearbySpots(
        centerLat: Double,
        centerLng: Double,
        radiusMeters: Int?,
        limit: Int?
    ): List<ParkingSpot> = withContext(Dispatchers.IO) {
        val baseUrl = getBaseUrl(context)
        val query = buildString {
            append("lat=").append(encode(centerLat.toString()))
            append("&lng=").append(encode(centerLng.toString()))
            radiusMeters?.let { append("&radius_m=").append(encode(it.toString())) }
            limit?.let { append("&limit=").append(encode(it.toString())) }
        }

        val url = URL("$baseUrl/nearby?$query")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 8000
            readTimeout = 8000
        }

        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream.bufferedReader().use(BufferedReader::readText)

            if (code !in 200..299) {
                throw IllegalStateException("HTTP $code: $body")
            }

            parseSpots(body)
        } finally {
            conn.disconnect()
        }
    }
}

private fun encode(s: String): String = URLEncoder.encode(s, "UTF-8")

private fun getBaseUrl(context: Context): String {
    val id = context.resources.getIdentifier("backend_base_url", "string", context.packageName)
    val configured = if (id != 0) context.getString(id) else ""
    return configured.trim().trimEnd('/').ifBlank { "http://10.0.2.2:8000" }
}

private fun parseSpots(body: String): List<ParkingSpot> {
    val trimmed = body.trim()
    val items: JSONArray = if (trimmed.startsWith("[")) {
        JSONArray(trimmed)
    } else {
        val obj = JSONObject(trimmed)
        when {
            obj.has("spots") -> obj.optJSONArray("spots") ?: JSONArray()
            obj.has("data") -> obj.optJSONArray("data") ?: JSONArray()
            else -> JSONArray()
        }
    }

    return buildList {
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            val id = o.optString("id").ifBlank {
                o.optString("spot_id").ifBlank { i.toString() }
            }
            val lat = o.optDouble("lat", Double.NaN)
            val lng = o.optDouble("lng", Double.NaN)
            if (lat.isNaN() || lng.isNaN()) continue

            val label = o.optString("label").ifBlank {
                o.optString("name").ifBlank { id }
            }

            val distance = o.optDoubleOrNull("distance_m")
                ?: o.optDoubleOrNull("distanceMeters")

            val probability = o.optDoubleOrNull("probability")
                ?: o.optDoubleOrNull("availability_probability")

            add(
                ParkingSpot(
                    id = id,
                    label = label,
                    lat = lat,
                    lng = lng,
                    distanceMeters = distance,
                    probability = probability
                )
            )
        }
    }
}

private fun JSONObject.optDoubleOrNull(key: String): Double? {
    if (!has(key) || isNull(key)) return null
    val v = opt(key)
    return when (v) {
        is Number -> v.toDouble()
        is String -> v.trim().toDoubleOrNull()
        else -> null
    }
}
