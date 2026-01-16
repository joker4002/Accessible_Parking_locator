package com.kingstonaccess.app.data

interface ParkingRepository {
    suspend fun getParkingLots(): List<ParkingLot>
}
