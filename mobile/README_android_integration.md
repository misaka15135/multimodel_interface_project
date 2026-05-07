Quick integration guide

Files created under mobile/ are intended as copy-paste sources into an Android Studio app module (app/src/main/...)

Steps to use:
1. Create a new Android Studio project (Kotlin). Package: com.gesturecontrol
2. Copy MainActivity.kt, GestureAccessibilityService.kt, CameraForegroundService.kt into app/src/main/java/com/gesturecontrol/
3. Copy activity_main.xml into app/src/main/res/layout/
4. Copy accessibility_service_config.xml into app/src/main/res/xml/
5. Paste the AndroidManifest.txt contents into app/src/main/AndroidManifest.xml and adjust icons/labels.
6. Add CameraX dependencies (see camera_integration.txt in repository) and implement startCameraAnalysis() in CameraForegroundService to run the model.
7. Enable the Accessibility Service in Settings -> Accessibility and grant CAMERA permission when prompted.
8. Use the MainActivity list to select target apps. The AccessibilityService will only inject swipe gestures when the selected app is in the foreground.

Notes:
- This skeleton uses broadcasts (com.gesturecontrol.GESTURE_DETECTED) to notify accessibility service. For lower latency consider binding the service.
- Running camera in background requires a foreground service with visible notification.
- Test on a real device (emulator camera background restrictions exist).
