const frame = document.querySelector("#sandboxFrame");
const startButton = document.querySelector("#startButton");
const calibrateButton = document.querySelector("#calibrateButton");
const dwellInput = document.querySelector("#dwellInput");
const scrollInput = document.querySelector("#scrollInput");
const statusBadge = document.querySelector("#statusBadge");
const xMetric = document.querySelector("#xMetric");
const yMetric = document.querySelector("#yMetric");
const tabMetric = document.querySelector("#tabMetric");
const calibrationMetric = document.querySelector("#calibrationMetric");
const hintText = document.querySelector("#hintText");

let activeTabId = null;
let hoverState = { startedAt: 0, fired: false, lastX: 0, lastY: 0 };

function setStatus(text) {
  statusBadge.textContent = text;
}

async function getActiveTab() {
  const stored = await chrome.storage.local.get({
    targetTabId: null,
    targetTabTitle: "未连接"
  });
  activeTabId = stored.targetTabId;
  tabMetric.textContent = activeTabId ? stored.targetTabTitle : "未连接";
}

async function sendToTab(message) {
  if (!activeTabId) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(activeTabId, message);
  } catch (error) {
    tabMetric.textContent = "发送失败";
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) {
    return;
  }

  const { type, payload } = event.data || {};
  if (type === "gaze-status") {
    setStatus(payload.text);
    return;
  }
  if (type === "gaze-metrics") {
    xMetric.textContent = payload.rawX.toFixed(3);
    yMetric.textContent = payload.rawY.toFixed(3);
    return;
  }
  if (type === "gaze-calibration") {
    calibrationMetric.textContent = payload.complete ? "已完成" : `${payload.step}/${payload.total}`;
    if (payload.complete) {
      hintText.textContent = "校准完成。回到目标网页，保持这个控制页在单独窗口中也可以继续使用。";
    }
    return;
  }
  if (type === "gaze-point") {
    if (!activeTabId) {
      return;
    }
    const width = payload.viewportWidth || 1365;
    const height = payload.viewportHeight || 768;
    const x = Math.round(payload.x * width);
    const y = Math.round(payload.y * height);
    await sendToTab({ type: "eye-hover", x, y });

    const movement = Math.hypot(x - hoverState.lastX, y - hoverState.lastY);
    if (movement > 36) {
      hoverState.startedAt = performance.now();
      hoverState.fired = false;
    }
    hoverState.lastX = x;
    hoverState.lastY = y;
    const dwellMs = Number(dwellInput.value);
    if (!hoverState.startedAt) {
      hoverState.startedAt = performance.now();
    }
    if (!hoverState.fired && performance.now() - hoverState.startedAt >= dwellMs) {
      hoverState.fired = true;
      await sendToTab({ type: "eye-click", x, y });
      setStatus("已执行点击");
    }

    if (payload.y < 0.15) {
      await sendToTab({ type: "eye-scroll", deltaY: -Number(scrollInput.value) });
    } else if (payload.y > 0.85) {
      await sendToTab({ type: "eye-scroll", deltaY: Number(scrollInput.value) });
    }
    return;
  }
});

startButton.addEventListener("click", async () => {
  await getActiveTab();
  frame.contentWindow.postMessage({ type: "start-tracking" }, "*");
  calibrateButton.disabled = false;
  setStatus("启动中");
});

calibrateButton.addEventListener("click", () => {
  hoverState = { startedAt: 0, fired: false, lastX: 0, lastY: 0 };
  frame.contentWindow.postMessage({ type: "start-calibration" }, "*");
});

chrome.tabs.onActivated.addListener(() => {
  hoverState = { startedAt: 0, fired: false, lastX: 0, lastY: 0 };
});

getActiveTab();
