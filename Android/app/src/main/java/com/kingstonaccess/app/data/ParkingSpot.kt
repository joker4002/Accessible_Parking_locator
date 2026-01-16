package com.kingstonaccess.app.data

data class ParkingSpot(
    val id: String,
    val label: String,
    val lat: Double,
    val lng: Double,
    val distanceMeters: Double?,
    val probability: Double?
)
