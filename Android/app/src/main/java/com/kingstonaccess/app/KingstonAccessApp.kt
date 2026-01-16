package com.kingstonaccess.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.kingstonaccess.app.ui.HomeMapScreen
import com.kingstonaccess.app.ui.ParkingSpotsViewModel
import com.kingstonaccess.app.ui.SettingsScreen

@Composable
fun KingstonAccessApp() {
    val navController = rememberNavController()
    val viewModel: ParkingSpotsViewModel = viewModel(
        factory = ParkingSpotsViewModel.factory(LocalContext.current.applicationContext)
    )

    val uiState by viewModel.uiState.collectAsState()

    NavHost(
        navController = navController,
        startDestination = "home"
    ) {
        composable("home") {
            HomeMapScreen(
                uiState = uiState,
                onOpenSettings = { navController.navigate("settings") },
                onSearchNearby = { lat, lng, radiusMeters, limit ->
                    viewModel.searchNearby(lat, lng, radiusMeters, limit)
                }
            )
        }
        composable("settings") {
            SettingsScreen(onBack = { navController.popBackStack() })
        }
    }
}
