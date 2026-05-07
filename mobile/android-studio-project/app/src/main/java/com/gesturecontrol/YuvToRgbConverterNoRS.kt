package com.gesturecontrol

import android.graphics.Bitmap

class YuvToRgbConverterNoRS {
    fun yuvToRgb(nv21: ByteArray, output: Bitmap) {
        val width = output.width
        val height = output.height
        val frameSize = width * height

        val pixels = IntArray(frameSize)

        var yp = 0
        var uvp = frameSize
        var u = 0
        var v = 0

        for (j in 0 until height) {
            var row = j * width
            var col = 0
            while (col < width) {
                val y = (nv21[yp].toInt() and 0xff)
                if ((col and 1) == 0) {
                    v = (nv21[uvp].toInt() and 0xff)
                    u = (nv21[uvp + 1].toInt() and 0xff)
                    uvp += 2
                }

                val y1192 = 1192 * (y - 16).coerceAtLeast(0)
                var r = (y1192 + 1634 * (v - 128)).coerceIn(0, 262143)
                var g = (y1192 - 833 * (v - 128) - 400 * (u - 128)).coerceIn(0, 262143)
                var b = (y1192 + 2066 * (u - 128)).coerceIn(0, 262143)

                val ir = (r shr 10) and 0xff
                val ig = (g shr 10) and 0xff
                val ib = (b shr 10) and 0xff

                pixels[row + col] = -0x1000000 or (ir shl 16) or (ig shl 8) or ib

                yp++
                col++
            }
        }

        output.setPixels(pixels, 0, width, 0, 0, width, height)
    }
}
