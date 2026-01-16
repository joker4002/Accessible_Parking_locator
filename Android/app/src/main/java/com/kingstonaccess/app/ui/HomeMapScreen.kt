package com.kingstonaccess.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.BottomSheetScaffold
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberBottomSheetScaffoldState
import androidx.compose.material3.rememberStandardBottomSheetState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.maps.android.compose.CameraPositionState
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.Polyline
import com.google.maps.android.compose.rememberCameraPositionState
import com.kingstonaccess.app.R
import com.kingstonaccess.app.data.HttpAiSearchRepository
import com.kingstonaccess.app.data.HttpDirectionsRepository
import com.kingstonaccess.app.data.HttpPlaceSearchRepository
import com.kingstonaccess.app.data.ParkingSpot
import kotlinx.coroutines.launch
import java.util.Locale

private data class GeocodedPlace(
    val id: String,
    val label: String,
    val subtitle: String,
    val latLng: LatLng,
    val isRecommended: Boolean = false
)

private const val KINGSTON_MIN_LAT = 44.10
private const val KINGSTON_MAX_LAT = 44.40
private const val KINGSTON_MIN_LNG = -76.70
private const val KINGSTON_MAX_LNG = -76.20

private fun isInKingstonBounds(latLng: LatLng): Boolean {
    return latLng.latitude in KINGSTON_MIN_LAT..KINGSTON_MAX_LAT &&
        latLng.longitude in KINGSTON_MIN_LNG..KINGSTON_MAX_LNG
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeMapScreen(
    uiState: ParkingSpotsUiState,
    onOpenSettings: () -> Unit,
    onSearchNearby: (Double, Double, Int?, Int?) -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val kingston = LatLng(44.2312, -76.4860)
    val cameraPositionState: CameraPositionState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(kingston, 12f)
    }

    var query by remember { mutableStateOf("") }
    var searchCenter by remember { mutableStateOf<LatLng?>(null) }
    var addressCandidates by remember { mutableStateOf<List<GeocodedPlace>>(emptyList()) }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var showSearchResults by remember { mutableStateOf(false) }
    var isSearchResultsMinimized by remember { mutableStateOf(false) }
    var lastSearchTerm by remember { mutableStateOf("") }

    var userLatLng by remember { mutableStateOf<LatLng?>(null) }
    var selectedSpot by remember { mutableStateOf<ParkingSpot?>(null) }
    var routePoints by remember { mutableStateOf<List<LatLng>>(emptyList()) }
    var walkingRoutePoints by remember { mutableStateOf<List<LatLng>>(emptyList()) }

    var aiRadiusMeters by remember { mutableStateOf<Int?>(null) }
    var aiLimit by remember { mutableStateOf<Int?>(null) }
    var aiRecommendedPlaceId by remember { mutableStateOf<String?>(null) }

    var hasLocationPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
        onResult = { result ->
            hasLocationPermission = (result[Manifest.permission.ACCESS_FINE_LOCATION] == true) ||
                (result[Manifest.permission.ACCESS_COARSE_LOCATION] == true)
        }
    )

    val mapsKey = stringResource(R.string.google_maps_key)
    val mapsKeyMissing = mapsKey == "YOUR_API_KEY" || mapsKey.isBlank()

    LaunchedEffect(Unit) {
        if (!hasLocationPermission) {
            permissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                )
            )
        }
    }

    suspend fun fetchAiSearchCandidates() {
        statusMessage = context.getString(R.string.loading)

        val q = query.trim()
        if (q.isEmpty()) {
            addressCandidates = emptyList()
            searchCenter = null
            statusMessage = null
            return
        }

        try {
            val repo = HttpAiSearchRepository(context)
            val ai = repo.aiSearch(
                text = q,
                minLat = KINGSTON_MIN_LAT,
                minLng = KINGSTON_MIN_LNG,
                maxLat = KINGSTON_MAX_LAT,
                maxLng = KINGSTON_MAX_LNG
            )

            val candidates = ai.places
                .mapNotNull { r ->
                    val latLng = LatLng(r.lat, r.lng)
                    if (!isInKingstonBounds(latLng)) return@mapNotNull null
                    GeocodedPlace(
                        id = r.id,
                        label = r.label,
                        subtitle = r.subtitle,
                        latLng = latLng,
                        isRecommended = (ai.selectedPlace?.id != null && ai.selectedPlace.id == r.id)
                    )
                }
            val recommended = ai.selectedPlace
                ?.takeIf { it.id.isNotBlank() }
                ?.let { p -> LatLng(p.lat, p.lng).takeIf { isInKingstonBounds(it) }?.let { it to p } }
                ?.let { (latLng, p) ->
                    GeocodedPlace(
                        id = p.id,
                        label = p.label,
                        subtitle = p.subtitle,
                        latLng = latLng,
                        isRecommended = true
                    )
                }

            addressCandidates = buildList {
                if (recommended != null) add(recommended)
                addAll(candidates)
            }.distinctBy { it.id }

            aiRadiusMeters = ai.radiusMeters
            aiLimit = ai.limit
            aiRecommendedPlaceId = ai.selectedPlace?.id

            if (candidates.isEmpty()) {
                statusMessage = context.getString(R.string.no_results)
            } else {
                statusMessage = null
            }
        } catch (t: Throwable) {
            addressCandidates = emptyList()
            statusMessage = t.message ?: context.getString(R.string.error_loading, "ai_search")
            searchCenter = null
            aiRecommendedPlaceId = null
        }
    }

    LaunchedEffect(hasLocationPermission) {
        if (hasLocationPermission) {
            val fused = LocationServices.getFusedLocationProviderClient(context)
            fused.lastLocation
                .addOnSuccessListener { loc ->
                    if (loc != null) {
                        userLatLng = LatLng(loc.latitude, loc.longitude)
                        scope.launch {
                            try {
                                cameraPositionState.animate(
                                    CameraUpdateFactory.newLatLngZoom(
                                        LatLng(loc.latitude, loc.longitude),
                                        13f
                                    )
                                )
                            } catch (_: Throwable) {
                            }
                        }
                    }
                }
        }
    }

    suspend fun fetchAndDrawRoute(to: ParkingSpot) {
        val origin = userLatLng ?: searchCenter
        if (origin == null) {
            routePoints = emptyList()
            walkingRoutePoints = emptyList()
            return
        }

        val directionsRepo = HttpDirectionsRepository()
        try {
            val res = directionsRepo.getPolylineResult(
                originLat = origin.latitude,
                originLng = origin.longitude,
                destinationLat = to.lat,
                destinationLng = to.lng,
                apiKey = mapsKey,
                mode = "driving"
            )

            val overviewDecoded = res.overviewPoints?.let { decodePolyline(it) }.orEmpty()
            routePoints = if (overviewDecoded.size > 2) {
                overviewDecoded
            } else {
                val stepDecoded = res.stepPoints
                    .flatMap { decodePolyline(it) }
                    .fold(mutableListOf<LatLng>()) { acc, p ->
                        if (acc.isEmpty() || acc.last() != p) acc.add(p)
                        acc
                    }
                if (stepDecoded.size > 2) stepDecoded else overviewDecoded
            }
        } catch (_: Throwable) {
            routePoints = emptyList()
        }
    }

    suspend fun fetchAndDrawWalkingRoute(from: ParkingSpot, to: LatLng?) {
        if (to == null) {
            walkingRoutePoints = emptyList()
            return
        }

        val directionsRepo = HttpDirectionsRepository()
        try {
            val res = directionsRepo.getPolylineResult(
                originLat = from.lat,
                originLng = from.lng,
                destinationLat = to.latitude,
                destinationLng = to.longitude,
                apiKey = mapsKey,
                mode = "walking"
            )

            val overviewDecoded = res.overviewPoints?.let { decodePolyline(it) }.orEmpty()
            walkingRoutePoints = if (overviewDecoded.size > 2) {
                overviewDecoded
            } else {
                val stepDecoded = res.stepPoints
                    .flatMap { decodePolyline(it) }
                    .fold(mutableListOf<LatLng>()) { acc, p ->
                        if (acc.isEmpty() || acc.last() != p) acc.add(p)
                        acc
                    }
                if (stepDecoded.size > 2) stepDecoded else overviewDecoded
            }
        } catch (_: Throwable) {
            walkingRoutePoints = emptyList()
        }
    }

    fun openMapsForLatLng(latLng: LatLng, label: String?) {
        val navigation = Uri.parse("google.navigation:q=${latLng.latitude},${latLng.longitude}")
        val gmmIntent = Intent(Intent.ACTION_VIEW, navigation).apply {
            setPackage("com.google.android.apps.maps")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        val fallback = Uri.parse(
            "https://www.google.com/maps/dir/?api=1&destination=${latLng.latitude},${latLng.longitude}"
        )
        val fallbackIntent = Intent(Intent.ACTION_VIEW, fallback).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        val pm = context.packageManager
        val chosen = if (gmmIntent.resolveActivity(pm) != null) gmmIntent else fallbackIntent
        context.startActivity(chosen)
    }

    suspend fun fetchAutocompleteCandidates() {
        statusMessage = context.getString(R.string.loading)

        val q = query.trim()
        if (q.isEmpty()) {
            addressCandidates = emptyList()
            searchCenter = null
            statusMessage = null
            return
        }

        try {
            val repo = HttpPlaceSearchRepository(context)
            val results = repo.autocomplete(
                query = q,
                limit = 20,
                minLat = KINGSTON_MIN_LAT,
                minLng = KINGSTON_MIN_LNG,
                maxLat = KINGSTON_MAX_LAT,
                maxLng = KINGSTON_MAX_LNG
            )

            val candidates = results
                .mapNotNull { r ->
                    val latLng = LatLng(r.lat, r.lng)
                    if (!isInKingstonBounds(latLng)) return@mapNotNull null
                    GeocodedPlace(
                        id = r.id,
                        label = r.label,
                        subtitle = r.subtitle,
                        latLng = latLng
                    )
                }

            addressCandidates = candidates

            if (candidates.isEmpty()) {
                statusMessage = context.getString(R.string.geocode_failed)
                searchCenter = null
            } else {
                statusMessage = null
            }

            aiRecommendedPlaceId = null
        } catch (t: Throwable) {
            addressCandidates = emptyList()
            statusMessage = t.message ?: context.getString(R.string.error_loading, "autocomplete")
            searchCenter = null
            aiRecommendedPlaceId = null
        }
    }

    LaunchedEffect(uiState) {
        statusMessage = when (uiState) {
            is ParkingSpotsUiState.Error -> context.getString(R.string.error_loading, uiState.message)
            else -> null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(text = stringResource(R.string.app_name)) },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            imageVector = Icons.Filled.Settings,
                            contentDescription = stringResource(R.string.settings)
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        val spots = (uiState as? ParkingSpotsUiState.Loaded)?.spots.orEmpty()
            .filter { isInKingstonBounds(LatLng(it.lat, it.lng)) }

        val bottomSheetState = rememberStandardBottomSheetState(
            initialValue = SheetValue.PartiallyExpanded,
            skipHiddenState = true
        )
        val bottomSheetScaffoldState = rememberBottomSheetScaffoldState(
            bottomSheetState = bottomSheetState
        )

        BottomSheetScaffold(
            scaffoldState = bottomSheetScaffoldState,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            sheetShape = RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp),
            sheetContainerColor = Color.White.copy(alpha = 0.86f),
            sheetPeekHeight = if (spots.isNotEmpty() || uiState is ParkingSpotsUiState.Loading) {
                if (selectedSpot != null) 76.dp else 160.dp
            } else {
                0.dp
            },
            sheetContent = {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = stringResource(R.string.nearby_accessible_parking),
                        style = MaterialTheme.typography.titleMedium
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    when (uiState) {
                        ParkingSpotsUiState.Idle -> {
                            Text(text = stringResource(R.string.no_results))
                        }

                        ParkingSpotsUiState.Loading -> {
                            Text(text = stringResource(R.string.loading))
                        }

                        is ParkingSpotsUiState.Error -> {
                            Text(text = stringResource(R.string.error_loading, uiState.message))
                        }

                        is ParkingSpotsUiState.Loaded -> {
                            if (spots.isEmpty()) {
                                Text(text = stringResource(R.string.no_results))
                            } else {
                                LazyColumn(
                                    modifier = Modifier.fillMaxWidth(),
                                    contentPadding = PaddingValues(bottom = 12.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    items(spots, key = { "${it.id}:${it.lat},${it.lng}" }) { spot ->
                                        ParkingSpotCard(
                                            spot = spot,
                                            onSelect = {
                                                scope.launch {
                                                    selectedSpot = spot
                                                    fetchAndDrawRoute(spot)
                                                    fetchAndDrawWalkingRoute(spot, searchCenter)

                                                    try {
                                                        bottomSheetState.partialExpand()
                                                    } catch (_: Throwable) {
                                                    }
                                                }
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        ) { sheetPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(sheetPadding)
            ) {
                GoogleMap(
                    modifier = Modifier.fillMaxSize(),
                    cameraPositionState = cameraPositionState,
                    properties = MapProperties(isMyLocationEnabled = hasLocationPermission),
                    uiSettings = MapUiSettings(
                        zoomControlsEnabled = false,
                        mapToolbarEnabled = false,
                        myLocationButtonEnabled = false,
                        compassEnabled = false
                    )
                ) {
                    searchCenter?.let {
                        Marker(
                            state = MarkerState(position = it),
                            title = stringResource(R.string.search)
                        )
                    }

                    if (routePoints.isNotEmpty()) {
                        Polyline(
                            points = routePoints,
                            color = Color.Red,
                            width = 10f
                        )
                    }

                    if (walkingRoutePoints.isNotEmpty()) {
                        Polyline(
                            points = walkingRoutePoints,
                            color = Color(0xFF1E88E5),
                            width = 9f
                        )
                    }

                    spots.forEach { spot ->
                        Marker(
                            state = MarkerState(position = LatLng(spot.lat, spot.lng)),
                            title = spot.label
                        )
                    }
                }

                Column(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .fillMaxWidth()
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    if (mapsKeyMissing) {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(20.dp),
                            colors = CardDefaults.cardColors(containerColor = Color.White.copy(alpha = 0.82f)),
                            elevation = CardDefaults.cardElevation(defaultElevation = 6.dp)
                        ) {
                            Text(
                                text = stringResource(R.string.maps_key_missing),
                                modifier = Modifier.padding(12.dp)
                            )
                        }
                    }

                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(22.dp),
                        colors = CardDefaults.cardColors(containerColor = Color.White.copy(alpha = 0.82f)),
                        elevation = CardDefaults.cardElevation(defaultElevation = 6.dp)
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            OutlinedTextField(
                                value = query,
                                onValueChange = { query = it },
                                modifier = Modifier.fillMaxWidth(),
                                shape = RoundedCornerShape(16.dp),
                                label = { Text(text = stringResource(R.string.search_location_hint)) },
                                singleLine = true
                            )

                            Row(
                                modifier = Modifier
                                    .padding(top = 10.dp)
                                    .fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Button(
                                    onClick = {
                                        scope.launch {
                                            lastSearchTerm = query.trim()
                                            aiRadiusMeters = null
                                            aiLimit = null
                                            isSearchResultsMinimized = false
                                            showSearchResults = true
                                            addressCandidates = emptyList()
                                            statusMessage = context.getString(R.string.loading)
                                            fetchAutocompleteCandidates()
                                        }
                                    },
                                    shape = RoundedCornerShape(16.dp),
                                    modifier = Modifier.weight(1f),
                                    enabled = true
                                ) {
                                    Text(text = stringResource(R.string.search))
                                }

                                Button(
                                    onClick = {
                                        scope.launch {
                                            lastSearchTerm = query.trim()
                                            aiRadiusMeters = null
                                            aiLimit = null
                                            isSearchResultsMinimized = false
                                            showSearchResults = true
                                            addressCandidates = emptyList()
                                            statusMessage = context.getString(R.string.loading)
                                            fetchAiSearchCandidates()
                                        }
                                    },
                                    shape = RoundedCornerShape(16.dp),
                                    modifier = Modifier.weight(1f),
                                    enabled = true
                                ) {
                                    Text(text = stringResource(R.string.ai_search))
                                }
                            }
                        }
                    }
                }

                Card(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 12.dp, bottom = 170.dp),
                    shape = RoundedCornerShape(18.dp),
                    colors = CardDefaults.cardColors(containerColor = Color.White.copy(alpha = 0.82f)),
                    elevation = CardDefaults.cardElevation(defaultElevation = 6.dp)
                ) {
                    Column(modifier = Modifier.padding(6.dp)) {
                        IconButton(
                            onClick = {
                                scope.launch {
                                    val current = cameraPositionState.position.zoom
                                    val target = (current + 1f).coerceAtMost(20f)
                                    try {
                                        cameraPositionState.animate(CameraUpdateFactory.zoomTo(target))
                                    } catch (_: Throwable) {
                                    }
                                }
                            }
                        ) {
                            Icon(imageVector = Icons.Filled.Add, contentDescription = "Zoom in")
                        }

                        IconButton(
                            onClick = {
                                scope.launch {
                                    val current = cameraPositionState.position.zoom
                                    val target = (current - 1f).coerceAtLeast(2f)
                                    try {
                                        cameraPositionState.animate(CameraUpdateFactory.zoomTo(target))
                                    } catch (_: Throwable) {
                                    }
                                }
                            }
                        ) {
                            Icon(imageVector = Icons.Filled.Remove, contentDescription = "Zoom out")
                        }
                    }
                }

                if (!showSearchResults && isSearchResultsMinimized) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp),
                        shape = RoundedCornerShape(20.dp),
                        colors = CardDefaults.cardColors(containerColor = Color.White),
                        elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = query.ifBlank { lastSearchTerm },
                                modifier = Modifier.weight(1f)
                            )
                            TextButton(
                                onClick = {
                                    isSearchResultsMinimized = false
                                    showSearchResults = true
                                }
                            ) {
                                Text(text = stringResource(R.string.search))
                            }
                            TextButton(
                                onClick = {
                                    showSearchResults = false
                                    isSearchResultsMinimized = false
                                }
                            ) {
                                Text(text = stringResource(R.string.close))
                            }
                        }
                    }
                }

                if (showSearchResults) {
                    Card(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(12.dp),
                        shape = RoundedCornerShape(24.dp),
                        colors = CardDefaults.cardColors(containerColor = Color.White),
                        elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = if (lastSearchTerm.isNotBlank()) {
                                        "${stringResource(R.string.select_address)}: $lastSearchTerm"
                                    } else {
                                        stringResource(R.string.select_address)
                                    },
                                    style = MaterialTheme.typography.titleSmall,
                                    modifier = Modifier.weight(1f)
                                )
                                TextButton(
                                    onClick = {
                                        showSearchResults = false
                                        isSearchResultsMinimized = false
                                    }
                                ) {
                                    Text(text = stringResource(R.string.close))
                                }
                            }

                            Spacer(modifier = Modifier.height(8.dp))

                            if (addressCandidates.isEmpty()) {
                                Text(text = statusMessage ?: stringResource(R.string.no_results))
                            } else {
                                LazyColumn(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalArrangement = Arrangement.spacedBy(6.dp)
                                ) {
                                    items(addressCandidates, key = { "${it.id}:${it.latLng.latitude},${it.latLng.longitude}" }) { place ->
                                        val highlight = place.isRecommended ||
                                            (aiRecommendedPlaceId != null && aiRecommendedPlaceId == place.id)

                                        Card(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .clickable {
                                                    scope.launch {
                                                        statusMessage = null
                                                        searchCenter = place.latLng
                                                        query = place.label
                                                        selectedSpot = null
                                                        routePoints = emptyList()
                                                        walkingRoutePoints = emptyList()
                                                        try {
                                                            cameraPositionState.animate(
                                                                CameraUpdateFactory.newLatLngZoom(place.latLng, 15f)
                                                            )
                                                        } catch (_: Throwable) {
                                                        }
                                                        onSearchNearby(
                                                            place.latLng.latitude,
                                                            place.latLng.longitude,
                                                            aiRadiusMeters,
                                                            aiLimit
                                                        )
                                                        showSearchResults = false
                                                        isSearchResultsMinimized = true
                                                    }
                                                },
                                            shape = RoundedCornerShape(18.dp),
                                            colors = CardDefaults.cardColors(
                                                containerColor = if (highlight) {
                                                    Color(0xFFEAF2FF)
                                                } else {
                                                    Color.White
                                                }
                                            ),
                                            border = if (highlight) BorderStroke(1.dp, Color(0xFF4F8EF7)) else null
                                        ) {
                                            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                                                val distanceText = userLatLng?.let {
                                                    formatDistance(
                                                        haversineMeters(
                                                            it.latitude,
                                                            it.longitude,
                                                            place.latLng.latitude,
                                                            place.latLng.longitude
                                                        )
                                                    )
                                                }

                                                Row(
                                                    modifier = Modifier.fillMaxWidth(),
                                                    verticalAlignment = Alignment.CenterVertically
                                                ) {
                                                    Text(
                                                        text = place.label,
                                                        modifier = Modifier.weight(1f)
                                                    )
                                                    if (distanceText != null) {
                                                        Text(text = distanceText)
                                                    }
                                                }
                                                if (place.subtitle.isNotBlank()) {
                                                    Text(text = place.subtitle)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ParkingSpotCard(
    spot: ParkingSpot,
    onSelect: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelect)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(text = spot.label, style = MaterialTheme.typography.titleSmall)
            spot.distanceMeters?.let { Text(text = formatDistance(it)) }
        }
    }
}

private fun formatDistance(meters: Double): String {
    return if (meters >= 1000.0) {
        String.format(Locale.getDefault(), "%.1f km", meters / 1000.0)
    } else {
        String.format(Locale.getDefault(), "%.0f m", meters)
    }
}

private fun haversineMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
    val r = 6371000.0
    val dLat = Math.toRadians(lat2 - lat1)
    val dLng = Math.toRadians(lng2 - lng1)
    val a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2)
    val c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return r * c
}

private fun decodePolyline(encoded: String): List<LatLng> {
    val poly = encoded.trim()
    if (poly.isEmpty()) return emptyList()

    val len = poly.length
    var index = 0
    var lat = 0
    var lng = 0
    val out = ArrayList<LatLng>()

    while (index < len) {
        var result = 0
        var shift = 0
        var b: Int
        do {
            b = poly[index++].code - 63
            result = result or ((b and 0x1f) shl shift)
            shift += 5
        } while (b >= 0x20 && index < len)
        val dlat = if ((result and 1) != 0) (result shr 1).inv() else (result shr 1)
        lat += dlat

        result = 0
        shift = 0
        do {
            b = poly[index++].code - 63
            result = result or ((b and 0x1f) shl shift)
            shift += 5
        } while (b >= 0x20 && index < len)
        val dlng = if ((result and 1) != 0) (result shr 1).inv() else (result shr 1)
        lng += dlng

        out.add(LatLng(lat / 1E5, lng / 1E5))
    }

    return out
}
