import { FaceLandmarker, FilesetResolver } from "../vendor/mediapipe/vision_bundle.mjs";

const LEFT_EYE = { outer: 33, inner: 133, upper: 159, lower: 145, iris: [468, 469, 470, 471] };
const RIGHT_EYE = { outer: 263, inner: 362, upper: 386, lower: 374, iris: [473, 474, 475, 476] };
const HEAD = { nose: 1, forehead: 10, chin: 152, leftEyeOuter: 33, rightEyeOuter: 263 };

const CALIBRATION_ORDER = ["center", "left", "right", "up", "down"];
const CALIBRATION_TARGETS = {
  center: { x: 0.5, y: 0.5, label: "Look at center" },
  left: { x: 0.18, y: 0.5, label: "Look left" },
  right: { x: 0.82, y: 0.5, label: "Look right" },
  up: { x: 0.5, y: 0.24, label: "Look up" },
  down: { x: 0.5, y: 0.78, label: "Look down" }
};

function averagePoint(points) {
  const total = points.reduce(
    (acc, point) => {
      acc.x += point.x;
      acc.y += point.y;
      return acc;
    },
    { x: 0, y: 0 }
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function medianPoint(points) {
  return {
    x: median(points.map((point) => point.x)),
    y: median(points.map((point) => point.y))
  };
}

function eyeMetrics(landmarks, indices) {
  const irisCenter = averagePoint(indices.iris.map((index) => landmarks[index]));
  const outer = landmarks[indices.outer];
  const inner = landmarks[indices.inner];
  const upper = landmarks[indices.upper];
  const lower = landmarks[indices.lower];
  const horizontalSpan = Math.max(Math.abs(inner.x - outer.x), 1e-5);
  const verticalSpan = Math.max(Math.abs(lower.y - upper.y), 1e-5);

  return {
    horizontalRatio: ((irisCenter.x - outer.x) / horizontalSpan) * 2 - 1,
    verticalRatio: ((irisCenter.y - upper.y) / verticalSpan) * 2 - 1,
    openness: verticalSpan / horizontalSpan
  };
}

function faceBox(landmarks) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of landmarks) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: Math.max(maxX - minX, 1e-5),
    height: Math.max(maxY - minY, 1e-5)
  };
}

function headMetrics(landmarks) {
  const box = faceBox(landmarks);
  const nose = landmarks[HEAD.nose];
  const forehead = landmarks[HEAD.forehead];
  const chin = landmarks[HEAD.chin];
  const leftEye = landmarks[HEAD.leftEyeOuter];
  const rightEye = landmarks[HEAD.rightEyeOuter];
  const eyeCenter = averagePoint([leftEye, rightEye]);
  const faceHeight = Math.max(Math.abs(chin.y - forehead.y), box.height, 1e-5);
  const faceWidth = Math.max(Math.abs(rightEye.x - leftEye.x), box.width * 0.45, 1e-5);

  return {
    horizontalRatio: (nose.x - eyeCenter.x) / faceWidth,
    verticalRatio: (nose.y - eyeCenter.y - faceHeight * 0.16) / faceHeight,
    box
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function waitForVideoReady(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Camera video did not become ready"));
    }, 8000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", handleReady);
      video.removeEventListener("loadedmetadata", handleReady);
      video.removeEventListener("error", handleError);
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Camera video element failed to load"));
    };

    video.addEventListener("loadeddata", handleReady, { once: true });
    video.addEventListener("loadedmetadata", handleReady, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

export class GazeEngine {
  constructor(options = {}) {
    this.config = {
      smoothing: 0.08,
      speed: 0.9,
      deadZone: 0.04,
      rawWindowSize: 7,
      minEyeOpen: 0.12,
      inputMode: "head",
      invertHeadX: true,
      invertHeadY: false,
      headFallbackXGain: 1.55,
      headFallbackYGain: 1.9,
      responseScale: 0.68,
      blinkEyeOpen: 0.14,
      blinkFramesRequired: 3,
      blinkClickMode: "long",
      longBlinkMs: 520,
      doubleBlinkWindowMs: 700,
      maxNaturalBlinkMs: 320,
      blinkCooldownMs: 1000,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user"
      },
      ...options.config
    };

    this.onStatus = options.onStatus || (() => {});
    this.onFace = options.onFace || (() => {});
    this.onMetrics = options.onMetrics || (() => {});
    this.onPoint = options.onPoint || (() => {});
    this.onFrame = options.onFrame || (() => {});
    this.onCalibration = options.onCalibration || (() => {});
    this.onBlink = options.onBlink || (() => {});

    this.faceLandmarker = null;
    this.video = null;
    this.mediaStream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.smoothed = { x: 0.5, y: 0.5 };
    this.rawHistory = [];
    this.blinkFrames = 0;
    this.blinkStartedAt = 0;
    this.blinkClosed = false;
    this.pendingShortBlinkAt = 0;
    this.lastBlinkAt = 0;
    this.calibration = {
      active: false,
      step: 0,
      samples: [],
      profile: null
    };
  }

  async start(video) {
    this.video = video;
    if (!this.mediaStream) {
      this.onStatus("Requesting camera");
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: this.config.video,
        audio: false
      });
      this.video.srcObject = this.mediaStream;
      this.video.muted = true;
      this.video.playsInline = true;
      await waitForVideoReady(this.video);
      await this.video.play();
      this.onStatus("Camera ready");
    }

    if (!this.faceLandmarker) {
      this.onStatus("Loading model");
      const wasmRoot = chrome.runtime.getURL("eye/vendor/mediapipe/wasm");
      const modelUrl = chrome.runtime.getURL("eye/assets/face_landmarker.task");
      const vision = await FilesetResolver.forVisionTasks(wasmRoot);

      this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelUrl
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false
      });
    }

    this.running = true;
    this.onStatus("Tracking");
    this.predict();
  }

  stop() {
    this.running = false;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
    }
    this.mediaStream = null;
  }

  setConfig(nextConfig) {
    this.config = {
      ...this.config,
      ...nextConfig
    };
  }

  startCalibration() {
    this.calibration = {
      active: true,
      step: 0,
      samples: [],
      profile: {}
    };
    this.onCalibration({
      active: true,
      step: 1,
      total: CALIBRATION_ORDER.length,
      current: CALIBRATION_TARGETS.center
    });
    this.onStatus(`Calibration: ${CALIBRATION_TARGETS.center.label}`);
  }

  getCalibrationTarget() {
    if (!this.calibration.active) {
      return null;
    }
    return CALIBRATION_TARGETS[CALIBRATION_ORDER[this.calibration.step]];
  }

  normalizeWithCalibration(rawX, rawY) {
    if (this.config.inputMode === "head") {
      rawX *= this.config.invertHeadX ? -1 : 1;
      rawY *= this.config.invertHeadY ? -1 : 1;
    }

    const profile = this.calibration.profile;
    let point;
    if (!profile || !profile.center || !profile.left || !profile.right || !profile.up || !profile.down) {
      const xGain = this.config.inputMode === "head" ? this.config.headFallbackXGain : 0.55;
      const yGain = this.config.inputMode === "head" ? this.config.headFallbackYGain : 0.7;
      point = {
        x: clamp(0.5 + rawX * xGain, 0, 1),
        y: clamp(0.5 + rawY * yGain, 0, 1)
      };
      return this.scaleResponse(point);
    }

    const xSpanLeft = Math.max(0.001, profile.center.x - profile.left.x);
    const xSpanRight = Math.max(0.001, profile.right.x - profile.center.x);
    const ySpanUp = Math.max(0.001, profile.center.y - profile.up.y);
    const ySpanDown = Math.max(0.001, profile.down.y - profile.center.y);

    const x =
      rawX < profile.center.x
        ? 0.5 - ((profile.center.x - rawX) / xSpanLeft) * 0.5
        : 0.5 + ((rawX - profile.center.x) / xSpanRight) * 0.5;
    const y =
      rawY < profile.center.y
        ? 0.5 - ((profile.center.y - rawY) / ySpanUp) * 0.5
        : 0.5 + ((rawY - profile.center.y) / ySpanDown) * 0.5;

    point = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    return this.scaleResponse(point);
  }

  scaleResponse(point) {
    const scale = this.config.inputMode === "head" ? this.config.responseScale : 1;
    return {
      x: clamp(0.5 + (point.x - 0.5) * scale, 0, 1),
      y: clamp(0.5 + (point.y - 0.5) * scale, 0, 1)
    };
  }

  stabilizeRaw(rawX, rawY) {
    this.rawHistory.push({ x: rawX, y: rawY });
    if (this.rawHistory.length > this.config.rawWindowSize) {
      this.rawHistory.shift();
    }
    return medianPoint(this.rawHistory);
  }

  applyDeadZone(point) {
    const dx = point.x - this.smoothed.x;
    const dy = point.y - this.smoothed.y;
    const distance = Math.hypot(dx, dy);
    const deadZone = this.config.deadZone;

    if (distance <= deadZone) {
      return { ...this.smoothed };
    }

    const scale = (distance - deadZone) / distance;
    return {
      x: this.smoothed.x + dx * scale,
      y: this.smoothed.y + dy * scale
    };
  }

  collectCalibration(rawX, rawY) {
    if (!this.calibration.active) {
      return;
    }

    this.calibration.samples.push({ x: rawX, y: rawY });
    this.onCalibration({
      active: true,
      step: this.calibration.step + 1,
      total: CALIBRATION_ORDER.length,
      current: this.getCalibrationTarget()
    });

    if (this.calibration.samples.length < 24) {
      return;
    }

    const key = CALIBRATION_ORDER[this.calibration.step];
    this.calibration.profile[key] = medianPoint(this.calibration.samples);
    this.calibration.samples = [];
    this.calibration.step += 1;

    if (this.calibration.step >= CALIBRATION_ORDER.length) {
      this.calibration.active = false;
      this.calibration.step = 0;
      this.onCalibration({
        active: false,
        step: CALIBRATION_ORDER.length,
        total: CALIBRATION_ORDER.length,
        complete: true
      });
      this.onStatus("Calibration complete");
      return;
    }

    const nextTarget = this.getCalibrationTarget();
    this.onCalibration({
      active: true,
      step: this.calibration.step + 1,
      total: CALIBRATION_ORDER.length,
      current: nextTarget
    });
    this.onStatus(`Calibration: ${nextTarget.label}`);
  }

  processLandmarks(landmarks) {
    const leftEye = eyeMetrics(landmarks, LEFT_EYE);
    const rightEye = eyeMetrics(landmarks, RIGHT_EYE);
    const head = headMetrics(landmarks);
    const eyeRawX = (leftEye.horizontalRatio + rightEye.horizontalRatio) / 2;
    const eyeRawY = (leftEye.verticalRatio + rightEye.verticalRatio) / 2;
    const rawX = this.config.inputMode === "head" ? head.horizontalRatio : eyeRawX;
    const rawY = this.config.inputMode === "head" ? head.verticalRatio : eyeRawY;
    const eyeOpen = (leftEye.openness + rightEye.openness) / 2;

    this.processBlink(eyeOpen);

    if (eyeOpen < this.config.minEyeOpen) {
      this.onMetrics({
        rawX,
        rawY,
        eyeRawX,
        eyeRawY,
        eyeOpen,
        skipped: true,
        normalizedX: this.smoothed.x,
        normalizedY: this.smoothed.y
      });
      this.onStatus("Blink detected");
      return;
    }

    const stableRaw = this.stabilizeRaw(rawX, rawY);
    const normalized = this.applyDeadZone(
      this.normalizeWithCalibration(stableRaw.x, stableRaw.y)
    );

    this.collectCalibration(stableRaw.x, stableRaw.y);

    this.smoothed.x += (normalized.x - this.smoothed.x) * this.config.smoothing * this.config.speed;
    this.smoothed.y += (normalized.y - this.smoothed.y) * this.config.smoothing * this.config.speed;

    this.onMetrics({
      rawX,
      rawY,
      eyeRawX,
      eyeRawY,
      stableRawX: stableRaw.x,
      stableRawY: stableRaw.y,
      headX: head.horizontalRatio,
      headY: head.verticalRatio,
      eyeOpen,
      normalizedX: normalized.x,
      normalizedY: normalized.y
    });

    this.onPoint({
      rawX,
      rawY,
      headX: head.horizontalRatio,
      headY: head.verticalRatio,
      x: this.smoothed.x,
      y: this.smoothed.y
    });
  }

  processBlink(eyeOpen) {
    const now = performance.now();
    const closed = eyeOpen < this.config.blinkEyeOpen;

    if (closed) {
      this.blinkFrames += 1;
      if (!this.blinkClosed && this.blinkFrames >= this.config.blinkFramesRequired) {
        this.blinkClosed = true;
        this.blinkStartedAt = now;
      }
      return;
    }

    if (!this.blinkClosed) {
      this.blinkFrames = 0;
      return;
    }

    const duration = now - this.blinkStartedAt;
    this.blinkClosed = false;
    this.blinkFrames = 0;

    if (now - this.lastBlinkAt < this.config.blinkCooldownMs) {
      return;
    }

    if (this.config.blinkClickMode === "long") {
      if (duration >= this.config.longBlinkMs) {
        this.emitBlinkClick("longBlink", duration, eyeOpen);
      } else {
        this.onStatus("Natural blink ignored");
      }
      return;
    }

    if (this.config.blinkClickMode === "double") {
      const isNaturalBlink = duration <= this.config.maxNaturalBlinkMs;
      if (!isNaturalBlink) {
        this.pendingShortBlinkAt = 0;
        this.onStatus("Blink ignored");
        return;
      }

      if (this.pendingShortBlinkAt && now - this.pendingShortBlinkAt <= this.config.doubleBlinkWindowMs) {
        this.pendingShortBlinkAt = 0;
        this.emitBlinkClick("doubleBlink", duration, eyeOpen);
      } else {
        this.pendingShortBlinkAt = now;
        this.onStatus("Blink once");
      }
    }
  }

  emitBlinkClick(kind, duration, eyeOpen) {
    this.lastBlinkAt = performance.now();
    this.onBlink({
      kind,
      duration,
      x: this.smoothed.x,
      y: this.smoothed.y,
      eyeOpen
    });
    this.onStatus(kind === "longBlink" ? "Long blink click" : "Double blink click");
  }

  predict() {
    if (!this.running || !this.faceLandmarker || !this.video) {
      return;
    }

    if (this.video.currentTime === this.lastVideoTime) {
      setTimeout(() => this.predict(), 16);
      return;
    }

    this.lastVideoTime = this.video.currentTime;
    const result = this.faceLandmarker.detectForVideo(this.video, performance.now());

    if (result.faceLandmarks.length > 0) {
      const landmarks = result.faceLandmarks[0];
      this.onFace({ detected: true });
      this.onFrame({
        landmarks,
        calibrationTarget: this.getCalibrationTarget()
      });
      this.processLandmarks(landmarks);
    } else {
      this.onFace({ detected: false });
      this.onFrame({
        landmarks: null,
        calibrationTarget: this.getCalibrationTarget()
      });
      this.onStatus("Waiting for face");
    }

    setTimeout(() => this.predict(), 16);
  }
}
