import { GazeEngine } from "../shared/gaze-engine.mjs";

const video = document.querySelector("#video");
const overlay = document.querySelector("#overlay");
const overlayCtx = overlay.getContext("2d");
const cursor = document.querySelector("#cursor");

function resizeOverlay() {
  overlay.width = overlay.clientWidth * window.devicePixelRatio;
  overlay.height = overlay.clientHeight * window.devicePixelRatio;
  overlayCtx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

function drawFrame(landmarks, calibrationTarget) {
  overlayCtx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  if (landmarks) {
    overlayCtx.strokeStyle = "rgba(255,255,255,0.45)";
    overlayCtx.lineWidth = 1.2;
    for (const point of landmarks) {
      overlayCtx.beginPath();
      overlayCtx.arc((1 - point.x) * overlay.clientWidth, point.y * overlay.clientHeight, 1.2, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
  }
  if (calibrationTarget) {
    overlayCtx.fillStyle = "rgba(54,211,153,0.95)";
    overlayCtx.beginPath();
    overlayCtx.arc(
      calibrationTarget.x * overlay.clientWidth,
      calibrationTarget.y * overlay.clientHeight,
      10,
      0,
      Math.PI * 2
    );
    overlayCtx.fill();
  }
}

function post(type, payload) {
  window.parent.postMessage({ type, payload }, "*");
}

const engine = new GazeEngine({
  onStatus: (text) => post("gaze-status", { text }),
  onMetrics: ({ rawX, rawY }) => post("gaze-metrics", { rawX, rawY }),
  onPoint: ({ x, y }) => {
    cursor.style.transform = `translate(${x * overlay.clientWidth}px, ${y * overlay.clientHeight}px)`;
    post("gaze-point", {
      x,
      y,
      viewportWidth: window.screen.availWidth,
      viewportHeight: window.screen.availHeight
    });
  },
  onFrame: ({ landmarks, calibrationTarget }) => drawFrame(landmarks, calibrationTarget),
  onCalibration: (payload) => post("gaze-calibration", payload)
});

window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) {
    return;
  }
  if (event.data.type === "start-tracking") {
    try {
      resizeOverlay();
      await engine.start(video);
    } catch (error) {
      post("gaze-status", { text: "Camera start failed" });
    }
  }
  if (event.data.type === "start-calibration") {
    engine.startCalibration();
  }
});

window.addEventListener("resize", resizeOverlay);
