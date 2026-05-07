package com.gesturecontrol

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import androidx.camera.core.ImageProxy
import java.io.ByteArrayOutputStream

object YuvUtils {
    // Note: yuv420ToNv21 is exposed for use by converters
    fun yuv420ToNv21(image: ImageProxy): ByteArray? {
        try {
            val yPlane = image.planes[0]
            val uPlane = image.planes[1]
            val vPlane = image.planes[2]

            val yBuffer = yPlane.buffer
            val uBuffer = uPlane.buffer
            val vBuffer = vPlane.buffer

            val ySize = yBuffer.remaining()
            val uSize = uBuffer.remaining()
            val vSize = vBuffer.remaining()

            val nv21 = ByteArray(ySize + uSize + vSize)

            yBuffer.get(nv21, 0, ySize)

            val width = image.width
            val height = image.height
            val chromaHeight = height / 2

            val uRowStride = uPlane.rowStride
            val uPixelStride = uPlane.pixelStride
            val vRowStride = vPlane.rowStride
            val vPixelStride = vPlane.pixelStride

            val uBytes = ByteArray(uBuffer.remaining())
            uBuffer.get(uBytes)
            val vBytes = ByteArray(vBuffer.remaining())
            vBuffer.get(vBytes)

            var position = ySize
            for (row in 0 until chromaHeight) {
                val uRowStart = row * uRowStride
                val vRowStart = row * vRowStride
                for (col in 0 until width step 2) {
                    val chromaCol = col / 2
                    val uIndex = uRowStart + chromaCol * uPixelStride
                    val vIndex = vRowStart + chromaCol * vPixelStride
                    val v = if (vIndex < vBytes.size) vBytes[vIndex] else 0
                    val u = if (uIndex < uBytes.size) uBytes[uIndex] else 0
                    nv21[position++] = v
                    nv21[position++] = u
                }
            }

            return nv21
        } catch (e: Exception) {
            e.printStackTrace()
            return null
        }
    }

    fun imageProxyToBitmap(image: ImageProxy): Bitmap? {
        val nv21 = yuv420ToNv21(image) ?: return null
        val width = image.width
        val height = image.height
        return try {
            val yuvImage = android.graphics.YuvImage(nv21, ImageFormat.NV21, width, height, null)
            val out = ByteArrayOutputStream()
            yuvImage.compressToJpeg(android.graphics.Rect(0, 0, width, height), 90, out)
            val bytes = out.toByteArray()
            var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            val rotation = image.imageInfo.rotationDegrees
            if (rotation != 0) {
                val matrix = Matrix()
                matrix.postRotate(rotation.toFloat())
                bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, matrix, true)
            }
            bmp
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
}
