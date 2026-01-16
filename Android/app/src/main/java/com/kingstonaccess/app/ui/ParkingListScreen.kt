package com.kingstonaccess.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.kingstonaccess.app.R
import com.kingstonaccess.app.data.ParkingLot

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ParkingListScreen(
    uiState: ParkingLotsUiState,
    onOpenDetail: (Int) -> Unit,
    onOpenMap: () -> Unit
) {
    var query by remember { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(title = { Text(text = stringResource(R.string.app_name)) })
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp)
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(text = stringResource(R.string.search_hint)) },
                singleLine = true
            )

            Spacer(modifier = Modifier.height(12.dp))

            Button(onClick = onOpenMap) {
                Text(text = stringResource(R.string.open_map))
            }

            Spacer(modifier = Modifier.height(12.dp))

            when (uiState) {
                is ParkingLotsUiState.Loading -> {
                    Text(text = stringResource(R.string.loading))
                }

                is ParkingLotsUiState.Error -> {
                    Text(text = stringResource(R.string.error_loading, uiState.message))
                }

                is ParkingLotsUiState.Loaded -> {
                    val filtered = uiState.lots.filter {
                        query.isBlank() || it.name.contains(query, ignoreCase = true)
                    }

                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        items(filtered, key = { it.objectId }) { lot ->
                            ParkingLotRow(
                                lot = lot,
                                onClick = { onOpenDetail(lot.objectId) }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ParkingLotRow(
    lot: ParkingLot,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = lot.name,
                style = MaterialTheme.typography.titleMedium
            )

            Spacer(modifier = Modifier.height(6.dp))

            Row(modifier = Modifier.fillMaxWidth()) {
                val handicap = lot.handicapSpaces?.toString() ?: stringResource(R.string.unknown)
                Text(text = stringResource(R.string.handicap_spaces, handicap))
            }

            Spacer(modifier = Modifier.height(4.dp))

            Row(modifier = Modifier.fillMaxWidth()) {
                val capacity = lot.capacity?.toString() ?: stringResource(R.string.unknown)
                Text(text = stringResource(R.string.capacity, capacity))
            }

            lot.ownership?.let {
                Spacer(modifier = Modifier.height(4.dp))
                Text(text = stringResource(R.string.ownership, it))
            }
        }
    }
}
