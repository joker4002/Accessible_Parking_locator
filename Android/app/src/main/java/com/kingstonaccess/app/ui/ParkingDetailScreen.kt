package com.kingstonaccess.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.kingstonaccess.app.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ParkingDetailScreen(
    uiState: ParkingLotsUiState,
    objectId: Int?,
    onBack: () -> Unit,
    onOpenMap: () -> Unit
) {
    val title = stringResource(R.string.details)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(text = title) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        androidx.compose.material3.Icon(
                            imageVector = Icons.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back)
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors()
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp)
        ) {
            if (uiState !is ParkingLotsUiState.Loaded || objectId == null) {
                Text(text = stringResource(R.string.loading))
                return@Column
            }

            val lot = uiState.lots.firstOrNull { it.objectId == objectId }
            if (lot == null) {
                Text(text = stringResource(R.string.error_loading, stringResource(R.string.unknown)))
                return@Column
            }

            Text(text = lot.name, style = MaterialTheme.typography.headlineSmall)

            Spacer(modifier = Modifier.height(12.dp))

            val handicap = lot.handicapSpaces?.toString() ?: stringResource(R.string.unknown)
            Text(text = stringResource(R.string.handicap_spaces, handicap))

            Spacer(modifier = Modifier.height(8.dp))

            val capacity = lot.capacity?.toString() ?: stringResource(R.string.unknown)
            Text(text = stringResource(R.string.capacity, capacity))

            Spacer(modifier = Modifier.height(8.dp))

            val ownership = lot.ownership ?: stringResource(R.string.unknown)
            Text(text = stringResource(R.string.ownership, ownership))

            Spacer(modifier = Modifier.height(8.dp))

            val controlType = lot.controlType?.toString() ?: stringResource(R.string.unknown)
            Text(text = stringResource(R.string.control_type, controlType))

            Spacer(modifier = Modifier.height(16.dp))

            if (lot.centroidLat != null && lot.centroidLng != null) {
                Text(
                    text = stringResource(
                        R.string.coordinates,
                        lot.centroidLat.toString(),
                        lot.centroidLng.toString()
                    )
                )
                Spacer(modifier = Modifier.height(16.dp))
            }

            Button(
                onClick = onOpenMap,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(text = stringResource(R.string.open_map))
            }
        }
    }
}
