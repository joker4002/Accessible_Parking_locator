package com.kingstonaccess.app.data

interface ParkingSpotRepository {
    suspend fun getNearbySpots(
        centerLat: Double,
        centerLng: Double,
        radiusMeters: Int? = null,
        limit: Int? = null
    ): List<ParkingSpot>
}
