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

data class AiSearchResponse(
    val selectedPlace: PlaceSearchResult?,
    val places: List<PlaceSearchResult>,
    val radiusMeters: Int?,
    val limit: Int?
)

class HttpAiSearchRepository(
    private val context: Context
) {

    suspend fun aiSearch(
        text: String,
        minLat: Double? = null,
        minLng: Double? = null,
        maxLat: Double? = null,
        maxLng: Double? = null
    ): AiSearchResponse = withContext(Dispatchers.IO) {
        val baseUrl = getBaseUrl(context)

        val queryParams = buildString {
            append("q=").append(encode(text))
            append("&text=").append(encode(text))
            minLat?.let { append("&min_lat=").append(encode(it.toString())) }
            minLng?.let { append("&min_lng=").append(encode(it.toString())) }
            maxLat?.let { append("&max_lat=").append(encode(it.toString())) }
            maxLng?.let { append("&max_lng=").append(encode(it.toString())) }
        }

        val url = URL("$baseUrl/ai/search?$queryParams")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 12000
            readTimeout = 12000
        }

        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream.bufferedReader().use(BufferedReader::readText)

            if (code !in 200..299) {
                throw IllegalStateException("HTTP $code: $body")
            }

            parseAiSearch(body)
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

private fun parseAiSearch(body: String): AiSearchResponse {
    val root = JSONObject(body.trim())

    val intent = root.optJSONObject("intent")
    val radiusMeters = intent?.optIntOrNull("radius_m")
    val limit = intent?.optIntOrNull("limit")

    val selected = root.optJSONObject("selected_place")?.let { parsePlaceObject(it) }

    val placesArr = root.optJSONArray("places") ?: JSONArray()
    val places = buildList {
        for (i in 0 until placesArr.length()) {
            val o = placesArr.optJSONObject(i) ?: continue
            val p = parsePlaceObject(o) ?: continue
            add(p)
        }
    }

    return AiSearchResponse(
        selectedPlace = selected,
        places = places,
        radiusMeters = radiusMeters,
        limit = limit
    )
}

private fun parsePlaceObject(o: JSONObject): PlaceSearchResult? {
    val lat = o.optDoubleOrNull("lat") ?: o.optDoubleOrNull("latitude")
    val lng = o.optDoubleOrNull("lng") ?: o.optDoubleOrNull("lon") ?: o.optDoubleOrNull("longitude")
    if (lat == null || lng == null) return null

    val id = o.optString("id").ifBlank {
        o.optString("place_id").ifBlank { o.optString("placeId").ifBlank { "${lat},${lng}" } }
    }

    val label = o.optString("label").ifBlank {
        o.optString("name").ifBlank { o.optString("title").ifBlank { id } }
    }

    val subtitle = o.optString("subtitle").ifBlank { o.optString("address") }

    return PlaceSearchResult(
        id = id,
        label = label,
        subtitle = subtitle,
        lat = lat,
        lng = lng
    )
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

private fun JSONObject.optIntOrNull(key: String): Int? {
    if (!has(key) || isNull(key)) return null
    val v = opt(key)
    return when (v) {
        is Number -> v.toInt()
        is String -> v.trim().toIntOrNull()
        else -> null
    }
}
