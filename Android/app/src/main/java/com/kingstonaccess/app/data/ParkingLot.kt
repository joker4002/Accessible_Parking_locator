package com.kingstonaccess.app.data

data class ParkingLot(
    val objectId: Int,
    val lotId: String?,
    val name: String,
    val capacity: Int?,
    val controlType: Int?,
    val handicapSpaces: Int?,
    val ownership: String?,
    val mapLabel: String?,
    val centroidLat: Double?,
    val centroidLng: Double?
)
