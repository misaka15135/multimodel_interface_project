package com.gesturecontrol

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import android.graphics.Bitmap
import android.graphics.Matrix
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import android.util.Log
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.support.common.FileUtil

class CameraForegroundService : Service() {

    private val CHANNEL_ID = "gesture-camera-channel"
    private val TAG = "CameraForegroundService"

    private val binder = LocalBinder()
    private var listener: GestureListener? = null

    interface GestureListener {
        fun onGesture(gesture: String)
    }

    inner class LocalBinder : Binder() {
        fun getService(): CameraForegroundService = this@CameraForegroundService
    }

    fun registerListener(l: GestureListener) { listener = l }
    fun unregisterListener() { listener = null }

    private val cameraExecutor = Executors.newSingleThreadExecutor()

    private var tflite: Interpreter? = null
    private val modelInputSize = 224
    private val modelNumChannels = 3
    private val modelNumClasses = 3

    private val bufferSize = 5
    private val predictionBuffer = IntArray(bufferSize) { 0 }
    private var bufferIndex = 0
    private var lastEmitTime = 0L
    private val emitCooldownMs = 800L

    private var yuvConverter: YuvToRgbConverterNoRS? = null
    private var rgbBitmap: Bitmap? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Gesture Control")
            .setContentText("Camera running to detect gestures")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .build()
        startForeground(1, notification)

        initInterpreter()
        yuvConverter = YuvToRgbConverterNoRS()
        startCameraAnalysis()
    }

    override fun onBind(intent: Intent?): IBinder? = binder

    override fun onDestroy() {
        cameraExecutor.shutdown()
        tflite?.close()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val chan = NotificationChannel(CHANNEL_ID, "Gesture camera", NotificationManager.IMPORTANCE_LOW)
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(chan)
        }
    }

    private fun initInterpreter() {
        try {
            val file = FileUtil.loadMappedFile(this, "gesture_model.tflite")
            tflite = Interpreter(file)
            Log.i(TAG, "TFLite model loaded")
        } catch (e: Exception) {
            Log.w(TAG, "Could not load tflite model: ${e.message}")
            tflite = null
        }
    }

    private fun startCameraAnalysis() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener(Runnable {
            val cameraProvider = cameraProviderFuture.get()

            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()

            analysis.setAnalyzer(ContextCompat.getMainExecutor(this)) { image: ImageProxy ->
                try {
                    val gesture = analyzeImageForGesture(image)
                    if (gesture != null) {
                        if (listener != null) {
                            listener?.onGesture(gesture)
                        } else {
                            val b = Intent("com.gesturecontrol.GESTURE_DETECTED")
                            b.putExtra("gesture", gesture)
                            sendBroadcast(b)
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "analysis error", e)
                } finally {
                    image.close()
                }
            }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    /* lifecycleOwner= */ this as androidx.lifecycle.LifecycleOwner,
                    CameraSelector.DEFAULT_FRONT_CAMERA,
                    analysis
                )
            } catch (exc: Exception) {
                Log.e(TAG, "camera bind failed", exc)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyzeImageForGesture(image: ImageProxy): String? {
        val interpreter = tflite ?: return null
        val bitmap = imageProxyToBitmap(image) ?: return null
        val scaled = Bitmap.createScaledBitmap(bitmap, modelInputSize, modelInputSize, true)
        val byteBuffer = convertBitmapToByteBuffer(scaled)
        val output = Array(1) { FloatArray(modelNumClasses) }
        interpreter.run(byteBuffer, output)
        val pred = output[0]
        val idx = argmax(pred)
        predictionBuffer[bufferIndex] = idx
        bufferIndex = (bufferIndex + 1) % bufferSize
        val counts = IntArray(modelNumClasses)
        for (i in 0 until bufferSize) counts[predictionBuffer[i]]++
        var bestIdx = 0
        var bestCount = counts[0]
        for (i in 1 until modelNumClasses) {
            if (counts[i] > bestCount) {
                bestCount = counts[i]
                bestIdx = i
            }
        }
        val now = System.currentTimeMillis()
        if (bestIdx != 0 && bestCount >= (bufferSize / 2 + 1) && (now - lastEmitTime) > emitCooldownMs) {
            lastEmitTime = now
            return when (bestIdx) {
                1 -> "LEFT"
                2 -> "RIGHT"
                else -> null
            }
        }
        return null
    }

    private fun argmax(arr: FloatArray): Int {
        var best = 0
        var bestVal = arr[0]
        for (i in 1 until arr.size) {
            if (arr[i] > bestVal) {
                bestVal = arr[i]
                best = i
            }
        }
        return best
    }

    private fun convertBitmapToByteBuffer(bitmap: Bitmap): ByteBuffer {
        val byteBuffer = ByteBuffer.allocateDirect(4 * modelInputSize * modelInputSize * modelNumChannels)
        byteBuffer.order(ByteOrder.nativeOrder())
        val intValues = IntArray(modelInputSize * modelInputSize)
        bitmap.getPixels(intValues, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        var pixel = 0
        for (i in 0 until modelInputSize) {
            for (j in 0 until modelInputSize) {
                val v = intValues[pixel++]
                val r = ((v shr 16) and 0xFF) / 255.0f
                val g = ((v shr 8) and 0xFF) / 255.0f
                val b = (v and 0xFF) / 255.0f
                byteBuffer.putFloat(r * 2 - 1)
                byteBuffer.putFloat(g * 2 - 1)
                byteBuffer.putFloat(b * 2 - 1)
            }
        }
        byteBuffer.rewind()
        return byteBuffer
    }

    private fun imageProxyToBitmap(image: ImageProxy): Bitmap? {
        try {
            val width = image.width
            val height = image.height
            if (rgbBitmap == null || rgbBitmap?.width != width || rgbBitmap?.height != height) {
                rgbBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            }
            val nv21 = YuvUtils.yuv420ToNv21(image) ?: return null
            yuvConverter?.yuvToRgb(nv21, rgbBitmap!!)
            val rotation = image.imageInfo.rotationDegrees
            if (rotation != 0) {
                val matrix = Matrix()
                matrix.postRotate(rotation.toFloat())
                val rotated = Bitmap.createBitmap(rgbBitmap!!, 0, 0, rgbBitmap!!.width, rgbBitmap!!.height, matrix, true)
                return rotated
            }
            return rgbBitmap
        } catch (e: Exception) {
            Log.e(TAG, "image->bitmap error", e)
            return null
        }
    }
}
