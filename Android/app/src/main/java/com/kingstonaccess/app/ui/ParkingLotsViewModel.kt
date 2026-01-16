package com.kingstonaccess.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.kingstonaccess.app.data.GeoJsonParkingRepository
import com.kingstonaccess.app.data.ParkingLot
import com.kingstonaccess.app.data.ParkingRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface ParkingLotsUiState {
    data object Loading : ParkingLotsUiState
    data class Loaded(val lots: List<ParkingLot>) : ParkingLotsUiState
    data class Error(val message: String) : ParkingLotsUiState
}

class ParkingLotsViewModel(
    application: Application,
    private val repository: ParkingRepository
) : AndroidViewModel(application) {

    private val _uiState = MutableStateFlow<ParkingLotsUiState>(ParkingLotsUiState.Loading)
    val uiState: StateFlow<ParkingLotsUiState> = _uiState.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        _uiState.value = ParkingLotsUiState.Loading
        viewModelScope.launch {
            try {
                val lots = repository.getParkingLots()
                    .sortedWith(compareByDescending<ParkingLot> { it.handicapSpaces ?: -1 }.thenBy { it.name })
                _uiState.value = ParkingLotsUiState.Loaded(lots)
            } catch (t: Throwable) {
                _uiState.value = ParkingLotsUiState.Error(t.message ?: "Unknown error")
            }
        }
    }

    fun findByObjectId(objectId: Int): ParkingLot? {
        val state = _uiState.value
        return if (state is ParkingLotsUiState.Loaded) {
            state.lots.firstOrNull { it.objectId == objectId }
        } else {
            null
        }
    }

    companion object {
        fun factory(applicationContext: android.content.Context): ViewModelProvider.Factory {
            val app = applicationContext.applicationContext as Application
            val repo = GeoJsonParkingRepository(app)
            return object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return ParkingLotsViewModel(app, repo) as T
                }
            }
        }
    }
}
