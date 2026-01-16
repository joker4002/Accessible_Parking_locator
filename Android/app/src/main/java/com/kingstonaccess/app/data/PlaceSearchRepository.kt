package com.kingstonaccess.app.data

interface PlaceSearchRepository {
    suspend fun autocomplete(
        query: String,
        limit: Int? = null,
        minLat: Double? = null,
        minLng: Double? = null,
        maxLat: Double? = null,
        maxLng: Double? = null
    ): List<PlaceSearchResult>
}
