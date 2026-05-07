package com.gesturecontrol

import android.content.Context
import android.graphics.Bitmap
import android.renderscript.Allocation
import android.renderscript.Element
import android.renderscript.RenderScript
import android.renderscript.ScriptIntrinsicYuvToRGB
import android.util.Log

// High-performance YUV -> RGB converter using RenderScript's ScriptIntrinsicYuvToRGB.
// Note: RenderScript is deprecated on newer Android versions but still works on many devices.
// Alternative: use GPU delegates or platform-specific intrinsics.
class YuvToRgbConverter(context: Context) {
    private val rs: RenderScript = RenderScript.create(context)
    private val script: ScriptIntrinsicYuvToRGB = ScriptIntrinsicYuvToRGB.create(rs, Element.U8_4(rs))
    private var yuvBytes: ByteArray? = null
    private var inAllocation: Allocation? = null

    private val TAG = "YuvToRgbConverter"

    fun yuvToRgb(nv21: ByteArray, output: Bitmap) {
        try {
            if (yuvBytes == null || yuvBytes!!.size != nv21.size) {
                yuvBytes = ByteArray(nv21.size)
                inAllocation = Allocation.createSized(rs, Element.U8(rs), nv21.size)
            }
            System.arraycopy(nv21, 0, yuvBytes!!, 0, nv21.size)
            inAllocation?.copyFrom(yuvBytes)
            script.setInput(inAllocation)
            val outAlloc = Allocation.createFromBitmap(rs, output)
            script.forEach(outAlloc)
            outAlloc.copyTo(output)
            outAlloc.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "yuvToRgb failed: ${e.message}")
        }
    }

    fun destroy() {
        try { inAllocation?.destroy() } catch (_: Exception) {}
        try { script.destroy() } catch (_: Exception) {}
        try { rs.destroy() } catch (_: Exception) {}
    }
}
