package com.gesturecontrol

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

class MainActivity : AppCompatActivity() {

    private val prefsName = "gesture_prefs"
    private val keySelected = "selected_packages"

    private val requestPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> }

    private lateinit var adapter: AppAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        requestPermissionLauncher.launch(Manifest.permission.CAMERA)

        findViewById<Button>(R.id.btn_enable_accessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        findViewById<Button>(R.id.btn_start_service).setOnClickListener {
            val i = Intent(this, CameraForegroundService::class.java)
            startForegroundService(i)
        }

        findViewById<Button>(R.id.btn_stop_service).setOnClickListener {
            val i = Intent(this, CameraForegroundService::class.java)
            stopService(i)
        }

        val recycler = findViewById<RecyclerView>(R.id.recycler_apps)
        recycler.layoutManager = LinearLayoutManager(this)
        val apps = loadLaunchableApps()
        adapter = AppAdapter(apps, this)
        recycler.adapter = adapter

        // Restore selections
        val prefs = getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        val selected = prefs.getStringSet(keySelected, emptySet()) ?: emptySet()
        adapter.setSelectedPackages(selected)

        findViewById<Button>(R.id.btn_save_selection).setOnClickListener {
            val checked = adapter.getSelectedPackages()
            prefs.edit().putStringSet(keySelected, checked).apply()
        }
    }

    private fun loadLaunchableApps(): List<AppAdapter.AppItem> {
        val pm = packageManager
        val intent = Intent(Intent.ACTION_MAIN, null)
        intent.addCategory(Intent.CATEGORY_LAUNCHER)
        val resolves = pm.queryIntentActivities(intent, 0)
        val apps = resolves.map {
            val label = it.loadLabel(pm).toString()
            val pkg = it.activityInfo.packageName
            val icon = it.loadIcon(pm)
            AppAdapter.AppItem(label, pkg, icon)
        }.sortedBy { it.label.lowercase() }
        return apps
    }
}
