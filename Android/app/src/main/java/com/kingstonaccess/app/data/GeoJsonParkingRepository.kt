package com.kingstonaccess.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class GeoJsonParkingRepository(
    private val context: Context
) : ParkingRepository {

    override suspend fun getParkingLots(): List<ParkingLot> = withContext(Dispatchers.IO) {
        val jsonText = context.assets.open("Parking_Lot_Areas.geojson").bufferedReader().use { it.readText() }
        val root = JSONObject(jsonText)
        val features = root.optJSONArray("features") ?: JSONArray()

        buildList {
            for (i in 0 until features.length()) {
                val feature = features.optJSONObject(i) ?: continue
                val properties = feature.optJSONObject("properties") ?: JSONObject()
                val geometry = feature.optJSONObject("geometry")

                val objectId = properties.optInt("OBJECTID", -1)
                if (objectId == -1) continue

                val lotName = properties.optString("LOT_NAME", "").trim()
                val mapLabel = properties.optString("MAP_LABEL", "").trim().ifBlank { null }

                val name = when {
                    lotName.isNotBlank() -> lotName
                    mapLabel != null -> mapLabel
                    else -> objectId.toString()
                }

                val lotId = properties.optString("LOT_ID", "").trim().ifBlank { null }
                val capacity = properties.optIntOrNull("CAPACITY")
                val controlType = properties.optIntOrNull("CONTROL_TYPE")
                val handicapSpaces = properties.optIntOrNull("HANDICAP_SPACE")
                val ownership = properties.optString("OWNERSHIP", "").trim().ifBlank { null }

                val centroid = geometry?.let { computeCentroid(it) }

                add(
                    ParkingLot(
                        objectId = objectId,
                        lotId = lotId,
                        name = name,
                        capacity = capacity,
                        controlType = controlType,
                        handicapSpaces = handicapSpaces,
                        ownership = ownership,
                        mapLabel = mapLabel,
                        centroidLat = centroid?.first,
                        centroidLng = centroid?.second
                    )
                )
            }
        }
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

private fun computeCentroid(geometry: JSONObject): Pair<Double, Double>? {
    val type = geometry.optString("type")
    val coordinates = geometry.optJSONArray("coordinates") ?: return null

    val points: List<Pair<Double, Double>> = when (type) {
        "Polygon" -> extractPolygonPoints(coordinates)
        "MultiPolygon" -> {
            if (coordinates.length() == 0) emptyList() else extractPolygonPoints(coordinates.optJSONArray(0) ?: JSONArray())
        }
        else -> emptyList()
    }

    if (points.isEmpty()) return null

    val avgLng = points.sumOf { it.first } / points.size
    val avgLat = points.sumOf { it.second } / points.size
    return avgLat to avgLng
}

private fun extractPolygonPoints(polygonCoordinates: JSONArray): List<Pair<Double, Double>> {
    val ring = polygonCoordinates.optJSONArray(0) ?: return emptyList()
    return buildList {
        for (i in 0 until ring.length()) {
            val coord = ring.optJSONArray(i) ?: continue
            val lng = coord.optDouble(0)
            val lat = coord.optDouble(1)
            if (!lng.isNaN() && !lat.isNaN()) {
                add(lng to lat)
            }
        }
    }
}
