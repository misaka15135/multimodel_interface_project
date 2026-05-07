Add to app/build.gradle (Kotlin DSL or Groovy) dependencies:

// CameraX
implementation "androidx.camera:camera-core:1.2.0"
implementation "androidx.camera:camera-camera2:1.2.0"
implementation "androidx.camera:camera-lifecycle:1.2.0"
implementation "androidx.camera:camera-view:1.2.0"

// TensorFlow Lite (optional, for model inference)
implementation 'org.tensorflow:tensorflow-lite:2.10.0'
implementation 'org.tensorflow:tensorflow-lite-support:0.4.0'
implementation 'org.tensorflow:tensorflow-lite-gpu:2.10.0'

// Lifecycle & RecyclerView
implementation 'androidx.recyclerview:recyclerview:1.2.1'
implementation 'androidx.lifecycle:lifecycle-runtime-ktx:2.4.1'

Notes:
- For MediaPipe, follow the MediaPipe Android setup (AARs or Maven). MediaPipe Hands provides robust hand landmarks and gesture detection but requires linking AARs or using Bazel builds.
- The CameraForegroundService.analyzeImageForGesture() contains a TFLite example. Put your model file under app/src/main/assets/gesture_model.tflite. The example expects a model with 3 classes: NONE=0, LEFT=1, RIGHT=2.
- Implementing imageProxyToBitmap(image) is required: use CameraX's YuvToRgbConverter (see the CameraX sample) or ScriptIntrinsicYuvToRgb for conversion, then resize to model input size (e.g., 224x224) and normalize pixels.
- For lower latency, consider using GPU delegate: add 'org.tensorflow:tensorflow-lite-gpu:2.10.0' and initialize Interpreter with the GPU delegate.
- For MediaPipe integration, consider using the official MediaPipe Android examples and map landmark sequences to LEFT/RIGHT gestures.
