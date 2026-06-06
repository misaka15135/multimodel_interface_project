const overlay = document.querySelector("#overlay");
const overlayCtx = overlay.getContext("2d");
const cursor = document.querySelector("#cursor");
const stageMessage = document.querySelector("#stageMessage");
const startButton = document.querySelector("#startButton");
const calibrateButton = document.querySelector("#calibrateButton");
const smoothingInput = document.querySelector("#smoothingInput");
const speedInput = document.querySelector("#speedInput");
const sensitivityInput = document.querySelector("#sensitivityInput");
const dwellInput = document.querySelector("#dwellInput");
const scrollInput = document.querySelector("#scrollInput");
const pointerInput = document.querySelector("#pointerInput");
const clickInput = document.querySelector("#clickInput");
const blinkClickInput = document.querySelector("#blinkClickInput");
const blinkModeInput = document.querySelector("#blinkModeInput");
const scrollEnabledInput = document.querySelector("#scrollEnabledInput");
const statusBadge = document.querySelector("#statusBadge");
const xMetric = document.querySelector("#xMetric");
const yMetric = document.querySelector("#yMetric");
const tabMetric = document.querySelector("#tabMetric");
const faceMetric = document.querySelector("#faceMetric");
const calibrationMetric = document.querySelector("#calibrationMetric");
const hintText = document.querySelector("#hintText");

let targetTabId = null;
let calibrationTarget = null;

function setStatus(text) {
  statusBadge.textContent = text;
}

function setStageMessage(title, body) {
  stageMessage.innerHTML = `<strong>${title}</strong><span>${body}</span>`;
}

function showTrackerStage(text) {
  if (text === "Requesting camera") {
    setStageMessage("正在请求摄像头", "如果浏览器弹出权限提示，请允许 Eye Control 使用摄像头。");
    return;
  }

  if (text === "Camera ready") {
    setStageMessage("摄像头已启动", "正在加载 MediaPipe 人脸模型。这里不会显示视频预览。");
    return;
  }

  if (text === "Loading model") {
    setStageMessage("正在加载模型", "模型文件来自扩展本地 assets 目录，第一次启动可能需要等几秒。");
    return;
  }

  if (text === "Tracking") {
    setStageMessage("后台追踪运行中", "请把脸放在摄像头中央，下面的人脸状态会显示是否检测到。");
    return;
  }

  if (text === "Waiting for face") {
    setStageMessage("等待人脸进入画面", "请确认摄像头没有被占用，脸部在画面中央，光线足够。");
    return;
  }

  if (/camera|video|getUserMedia|permission|NotAllowed|NotReadable|NotFound/i.test(text)) {
    setStageMessage("摄像头启动失败", text);
  }
}

function resizeOverlay() {
  overlay.width = overlay.clientWidth * window.devicePixelRatio;
  overlay.height = overlay.clientHeight * window.devicePixelRatio;
  overlayCtx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  drawPanel();
}

function drawPanel(point) {
  overlayCtx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);

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

  if (point) {
    cursor.style.opacity = "1";
    cursor.style.transform = `translate(${point.x * overlay.clientWidth}px, ${point.y * overlay.clientHeight}px)`;
  }
}

function buildTrackerConfig() {
  return {
    smoothing: Number(smoothingInput.value),
    speed: Number(speedInput.value),
    responseScale: Number(sensitivityInput.value),
    blinkClickMode: blinkModeInput.value,
    inputMode: "head"
  };
}

function buildControlSettings() {
  return {
    pointerEnabled: pointerInput.checked,
    dwellClickEnabled: clickInput.checked,
    blinkClickEnabled: blinkClickInput.checked,
    scrollEnabled: scrollEnabledInput.checked,
    dwellMs: Number(dwellInput.value),
    scrollSpeed: Number(scrollInput.value)
  };
}

async function restoreTargetTab() {
  const stored = await chrome.storage.local.get({
    targetTabId: null,
    targetTabTitle: "未连接"
  });
  targetTabId = stored.targetTabId;
  tabMetric.textContent = targetTabId ? stored.targetTabTitle : "未连接";
}

async function sendControlSettings() {
  const response = await chrome.runtime.sendMessage({
    type: "control-settings",
    config: buildTrackerConfig(),
    settings: buildControlSettings()
  });
  if (response && response.ok === false) {
    setStatus("设置未同步");
  }
}

startButton.addEventListener("click", async () => {
  try {
    await restoreTargetTab();
    const response = await chrome.runtime.sendMessage({
      type: "control-start",
      config: buildTrackerConfig(),
      settings: buildControlSettings()
    });
    if (!response || response.ok === false) {
      throw new Error(response && response.error ? response.error : "后台追踪启动失败");
    }
    calibrateButton.disabled = false;
    startButton.textContent = "已启动";
    setStatus("后台追踪中");
    setStageMessage("后台摄像头运行中", "视频在隐藏页面中处理，所以这里不会显示摄像头画面。看人脸状态和水平/垂直数值即可。");
    hintText.textContent = "现在可以关闭或最小化这个面板，后台会继续控制目标网页。";
  } catch (error) {
    setStatus("启动失败");
    hintText.textContent = String(error.message || error);
    setStageMessage("启动失败", String(error.message || error));
  }
});

calibrateButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "control-calibrate" });
  if (!response || response.ok === false) {
    setStatus("标定失败");
    return;
  }
  calibrationMetric.textContent = "1/5";
});

for (const input of [
  smoothingInput,
  speedInput,
  sensitivityInput,
  blinkModeInput,
  clickInput,
  blinkClickInput,
  scrollEnabledInput,
  dwellInput,
  scrollInput
]) {
  input.addEventListener("input", sendControlSettings);
  input.addEventListener("change", sendControlSettings);
}

pointerInput.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "control-pointer-visible",
    visible: pointerInput.checked
  });
  await sendControlSettings();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "target-tab-changed") {
    targetTabId = message.targetTabId;
    tabMetric.textContent = message.targetTabTitle || "当前标签";
    return;
  }

  if (message.type === "tracker-status") {
    setStatus(message.text);
    showTrackerStage(message.text || "");
    return;
  }

  if (message.type === "tracker-face") {
    const detected = Boolean(message.payload && message.payload.detected);
    faceMetric.textContent = detected ? "已检测" : "未检测";
    if (!detected) {
      setStageMessage("等待人脸进入画面", "请确认摄像头没有被占用，脸部在画面中央，光线足够。");
    }
    return;
  }

  if (message.type === "tracker-metrics") {
    const metrics = message.metrics;
    xMetric.textContent = (metrics.headX ?? metrics.rawX ?? 0).toFixed(3);
    yMetric.textContent = (metrics.headY ?? metrics.rawY ?? 0).toFixed(3);
    return;
  }

  if (message.type === "ui-point") {
    drawPanel(message.point);
    return;
  }

  if (message.type === "tracker-calibration") {
    const payload = message.calibration;
    calibrationMetric.textContent = payload.complete ? "已完成" : `${payload.step}/${payload.total}`;
    if (payload.complete) {
      calibrationTarget = null;
      hintText.textContent = "标定完成。后台会继续追踪脸部方向和眨眼点击。";
    }
    return;
  }

  if (message.type === "tracker-frame") {
    calibrationTarget = message.calibrationTarget || null;
    drawPanel();
  }
});

window.addEventListener("resize", resizeOverlay);

restoreTargetTab();
resizeOverlay();
