package com.kingstonaccess.app

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import com.kingstonaccess.app.settings.LocalePrefs
import com.kingstonaccess.app.ui.theme.MyApplicationTheme

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        LocalePrefs.applySavedLocale(applicationContext)
        enableEdgeToEdge()
        setContent {
            MyApplicationTheme {
                KingstonAccessApp()
            }
        }
    }
}