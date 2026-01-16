package com.kingstonaccess.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.kingstonaccess.app.data.HttpParkingSpotRepository
import com.kingstonaccess.app.data.ParkingSpot
import com.kingstonaccess.app.data.ParkingSpotRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface ParkingSpotsUiState {
    data object Idle : ParkingSpotsUiState
    data object Loading : ParkingSpotsUiState
    data class Loaded(val spots: List<ParkingSpot>) : ParkingSpotsUiState
    data class Error(val message: String) : ParkingSpotsUiState
}

class ParkingSpotsViewModel(
    application: Application,
    private val repository: ParkingSpotRepository
) : AndroidViewModel(application) {

    private val _uiState = MutableStateFlow<ParkingSpotsUiState>(ParkingSpotsUiState.Idle)
    val uiState: StateFlow<ParkingSpotsUiState> = _uiState.asStateFlow()

    fun searchNearby(
        centerLat: Double,
        centerLng: Double,
        radiusMeters: Int? = null,
        limit: Int? = null
    ) {
        _uiState.value = ParkingSpotsUiState.Loading
        viewModelScope.launch {
            try {
                val spots = repository.getNearbySpots(
                    centerLat = centerLat,
                    centerLng = centerLng,
                    radiusMeters = radiusMeters ?: 1500,
                    limit = limit ?: 30
                )
                _uiState.value = ParkingSpotsUiState.Loaded(spots)
            } catch (t: Throwable) {
                _uiState.value = ParkingSpotsUiState.Error(t.message ?: "Unknown error")
            }
        }
    }

    companion object {
        fun factory(applicationContext: android.content.Context): ViewModelProvider.Factory {
            val app = applicationContext.applicationContext as Application
            val repo = HttpParkingSpotRepository(app)
            return object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return ParkingSpotsViewModel(app, repo) as T
                }
            }
        }
    }
}
