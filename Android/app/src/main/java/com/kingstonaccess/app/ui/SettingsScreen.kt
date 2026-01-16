package com.kingstonaccess.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.kingstonaccess.app.R
import com.kingstonaccess.app.settings.LocalePrefs

private data class LanguageOption(
    val id: String,
    val title: Int
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit
) {
    val context = LocalContext.current
    var selected by remember { mutableStateOf(LocalePrefs.getLanguage(context)) }

    val options = listOf(
        LanguageOption("system", R.string.follow_system),
        LanguageOption("en", R.string.english),
        LanguageOption("zh", R.string.chinese),
        LanguageOption("fr", R.string.french)
    )

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(text = stringResource(R.string.settings)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back)
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .padding(12.dp)
        ) {
            Text(
                text = stringResource(R.string.language),
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp)
            )

            options.forEach { opt ->
                ListItem(
                    headlineContent = { Text(text = stringResource(opt.title)) },
                    leadingContent = {
                        RadioButton(
                            selected = selected == opt.id,
                            onClick = null
                        )
                    },
                    modifier = Modifier
                        .clickable {
                            selected = opt.id
                            LocalePrefs.setLanguage(context, opt.id)
                        }
                )
            }
        }
    }
}
