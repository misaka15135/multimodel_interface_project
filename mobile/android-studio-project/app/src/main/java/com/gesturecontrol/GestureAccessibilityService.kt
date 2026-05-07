package com.gesturecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Path
import android.os.IBinder
import android.view.accessibility.AccessibilityEvent

class GestureAccessibilityService : AccessibilityService() {

    private var currentForegroundPackage: String? = null
    private lateinit var prefsName: String

    private var cameraService: CameraForegroundService? = null
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? CameraForegroundService.LocalBinder
            cameraService = binder?.getService()
            cameraService?.registerListener(object : CameraForegroundService.GestureListener {
                override fun onGesture(gesture: String) {
                    handleGesture(gesture)
                }
            })
        }

        override fun onServiceDisconnected(name: ComponentName?) { cameraService = null }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefsName = "gesture_prefs"
        val intent = Intent(this, CameraForegroundService::class.java)
        bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            val pkg = event.packageName
            if (pkg != null) currentForegroundPackage = pkg.toString()
        }
    }

    override fun onInterrupt() {}

    private fun handleGesture(gesture: String) {
        val prefs = getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        val selected = prefs.getStringSet("selected_packages", emptySet()) ?: emptySet()
        if (currentForegroundPackage != null && selected.contains(currentForegroundPackage)) {
            when (gesture) {
                "LEFT" -> performSwipeLeft()
                "RIGHT" -> performSwipeRight()
            }
        }
    }

    fun performSwipeLeft() {
        val path = Path().apply { moveTo(900f, 500f); lineTo(100f, 500f) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 200))
            .build()
        dispatchGesture(gesture, null, null)
    }

    fun performSwipeRight() {
        val path = Path().apply { moveTo(100f, 500f); lineTo(900f, 500f) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 200))
            .build()
        dispatchGesture(gesture, null, null)
    }

    override fun onDestroy() {
        try { unbindService(connection) } catch (e: Exception) {}
        super.onDestroy()
    }
}
