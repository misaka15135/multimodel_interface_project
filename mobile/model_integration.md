Model integration guide (MediaPipe vs TFLite)

Goal: detect left/right swipe gestures from camera frames and emit "LEFT" or "RIGHT" to AccessibilityService.

Options:
1) MediaPipe Hands (recommended for hand landmarks):
   - Pros: robust hand landmarks, gesture recognition pipeline, high accuracy.
   - Cons: heavier integration, AARs or Bazel builds required.
   - Steps:
     1. Follow MediaPipe Android setup: include the prebuilt AAR or build via Bazel.
     2. Use the Hands solution to get landmarks per frame.
     3. Implement a simple state machine: track index/finger/wrist positions across frames; detect left-to-right or right-to-left movement of the hand centroid or specific finger landmarks to classify LEFT/RIGHT swipes.
     4. When gesture is recognized, call listener?.onGesture("LEFT") or "RIGHT".

2) TFLite (small classifier on cropped image or keypoint sequence):
   - Pros: easier to ship as a single .tflite in assets; can be optimized (quantized).
   - Cons: requires training a model or converting an existing one.
   - Steps:
     1. Prepare a dataset of hand images or landmark sequences labeled NONE/LEFT/RIGHT.
     2. Train a small CNN or LSTM and export to TFLite (3-class softmax output).
     3. Put gesture_model.tflite into app/src/main/assets/
     4. Use the CameraForegroundService.analyzeImageForGesture() example: convert ImageProxy to a scaled RGB bitmap, convert to ByteBuffer, and run tflite.run(input, output).

Performance tips:
- Run inference on a background thread (cameraExecutor used).
- Use a small input size (e.g., 96-160) for faster inference with acceptable accuracy.
- Quantize the model to uint8 or use GPU delegate for improved speed on supported devices.
- Debounce predictions: require consistent predictions across N frames before firing a gesture event.

Implementing imageProxyToBitmap
- Use CameraX sample's YuvToRgbConverter (available in CameraX project samples).
- Example approach:
  1. Create a Bitmap with the image width/height.
  2. Use YuvToRgbConverter.yuvToRgb(image.image, bitmap) to fill the bitmap.
  3. Rotate the bitmap according to image.imageInfo.rotationDegrees if needed.
  4. Resize to model input size and pass to convertBitmapToByteBuffer.

Debouncing example in service:
- Keep a small circular buffer of last 5 predictions; only emit when 3/5 agree and transition from NONE to LEFT/RIGHT.

Putting it together
1. Add dependencies from build_gradle_snippet.md
2. Add model to assets
3. Implement image conversion util (YuvToRgbConverter)
4. Test on device and log outputs. Tune thresholds and debounce parameters.

References:
- CameraX sample: https://github.com/android/camera-samples
- MediaPipe Hands Android example
- TensorFlow Lite Android quickstart
