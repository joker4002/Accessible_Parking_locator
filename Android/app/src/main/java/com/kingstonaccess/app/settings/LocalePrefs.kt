package com.kingstonaccess.app.settings

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

object LocalePrefs {
    private const val PREFS_NAME = "kingstonaccess_prefs"
    private const val KEY_APP_LANGUAGE = "app_language"

    fun applySavedLocale(context: Context) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val value = prefs.getString(KEY_APP_LANGUAGE, null)
        val locales = when (value) {
            null, "system" -> LocaleListCompat.getEmptyLocaleList()
            else -> LocaleListCompat.forLanguageTags(value)
        }
        AppCompatDelegate.setApplicationLocales(locales)
    }

    fun setLanguage(context: Context, languageTagOrSystem: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_APP_LANGUAGE, languageTagOrSystem).apply()
        val locales = if (languageTagOrSystem == "system") {
            LocaleListCompat.getEmptyLocaleList()
        } else {
            LocaleListCompat.forLanguageTags(languageTagOrSystem)
        }
        AppCompatDelegate.setApplicationLocales(locales)
    }

    fun getLanguage(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_APP_LANGUAGE, "system") ?: "system"
    }
}
