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

class HttpPlaceSearchRepository(
    private val context: Context
) : PlaceSearchRepository {

    override suspend fun autocomplete(
        query: String,
        limit: Int?,
        minLat: Double?,
        minLng: Double?,
        maxLat: Double?,
        maxLng: Double?
    ): List<PlaceSearchResult> = withContext(Dispatchers.IO) {
        val baseUrl = getBaseUrl(context)

        val queryParams = buildString {
            append("q=").append(encode(query))
            append("&query=").append(encode(query))
            limit?.let { append("&limit=").append(encode(it.toString())) }
            minLat?.let { append("&min_lat=").append(encode(it.toString())) }
            minLng?.let { append("&min_lng=").append(encode(it.toString())) }
            maxLat?.let { append("&max_lat=").append(encode(it.toString())) }
            maxLng?.let { append("&max_lng=").append(encode(it.toString())) }
        }

        val url = URL("$baseUrl/autocomplete?$queryParams")
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

            parsePlaces(body)
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

private fun parsePlaces(body: String): List<PlaceSearchResult> {
    val trimmed = body.trim()

    val items: JSONArray = if (trimmed.startsWith("[")) {
        JSONArray(trimmed)
    } else {
        val obj = JSONObject(trimmed)
        when {
            obj.has("results") -> obj.optJSONArray("results") ?: JSONArray()
            obj.has("data") -> obj.optJSONArray("data") ?: JSONArray()
            obj.has("places") -> obj.optJSONArray("places") ?: JSONArray()
            obj.has("predictions") -> obj.optJSONArray("predictions") ?: JSONArray()
            obj.has("candidates") -> obj.optJSONArray("candidates") ?: JSONArray()
            else -> JSONArray()
        }
    }

    return buildList {
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue

            val id = o.optString("id").ifBlank {
                o.optString("place_id").ifBlank {
                    o.optString("placeId").ifBlank { i.toString() }
                }
            }

            val label = o.optString("label").ifBlank {
                o.optString("name").ifBlank {
                    o.optString("title").ifBlank {
                        o.optString("main_text").ifBlank {
                            o.optString("description").ifBlank { id }
                        }
                    }
                }
            }

            val subtitle = o.optString("subtitle").ifBlank {
                o.optString("address").ifBlank {
                    o.optString("vicinity").ifBlank {
                        o.optString("secondary_text").ifBlank {
                            o.optString("description").takeIf { it != label }.orEmpty()
                        }
                    }
                }
            }

            val latLng = extractLatLng(o) ?: continue
            add(
                PlaceSearchResult(
                    id = id,
                    label = label,
                    subtitle = subtitle,
                    lat = latLng.first,
                    lng = latLng.second
                )
            )
        }
    }
}

private fun extractLatLng(o: JSONObject): Pair<Double, Double>? {
    val lat = o.optDoubleOrNull("lat")
        ?: o.optDoubleOrNull("latitude")

    val lng = o.optDoubleOrNull("lng")
        ?: o.optDoubleOrNull("lon")
        ?: o.optDoubleOrNull("longitude")

    if (lat != null && lng != null) return lat to lng

    val geometry = o.optJSONObject("geometry")
    val location = geometry?.optJSONObject("location") ?: o.optJSONObject("location")
    val nestedLat = location?.optDoubleOrNull("lat") ?: location?.optDoubleOrNull("latitude")
    val nestedLng = location?.optDoubleOrNull("lng")
        ?: location?.optDoubleOrNull("lon")
        ?: location?.optDoubleOrNull("longitude")

    if (nestedLat != null && nestedLng != null) return nestedLat to nestedLng

    return null
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
