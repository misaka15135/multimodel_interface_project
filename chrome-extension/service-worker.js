const OFFSCREEN_URL = "offscreen.html";

// service-worker.js 是整个扩展的“调度中心”：
// 1. 接收控制面板 app.js 发来的启动、标定、设置消息。
// 2. 创建 offscreen.html，让隐藏页面长期持有摄像头和 MediaPipe 模型。
// 3. 把追踪到的点、眨眼事件转发到当前目标网页的 content-script.js。
// 4. 目标页面切换后，自动更新控制对象，避免点击跳转后还控制旧页面。

let creatingOffscreen;
let controlSettings = {
  pointerEnabled: true,
  dwellClickEnabled: false,
  blinkClickEnabled: true,
  scrollEnabled: true,
  dwellMs: 1500,
  scrollSpeed: 60
};
let hoverState = { startedAt: 0, fired: false, lastX: 0, lastY: 0 };
let lastHoverSentAt = 0;
let lastScrollSentAt = 0;

chrome.runtime.onInstalled.addListener(() => {
  // 默认启用网页控制。这个值目前由 popup 开关维护，方便以后扩展成总开关。
  chrome.storage.local.set({ enabled: true });
});

function isControllableUrl(url = "") {
  // Chrome 系统页、扩展商店等页面不能注入 content script，所以只允许普通网页和本地 file 页面。
  return /^https?:\/\//.test(url) || /^file:\/\//.test(url);
}

function resetHoverState() {
  hoverState = { startedAt: 0, fired: false, lastX: 0, lastY: 0 };
}

async function setTargetTab(tab) {
  if (!tab || !tab.id || !isControllableUrl(tab.url)) {
    return false;
  }

  const title = tab.title || tab.url || "当前标签";
  // 目标标签页存进 storage，service worker 被 Chrome 回收后也能恢复目标。
  await chrome.storage.local.set({
    targetTabId: tab.id,
    targetTabTitle: title
  });
  resetHoverState();
  chrome.runtime.sendMessage({
    type: "target-tab-changed",
    targetTabId: tab.id,
    targetTabTitle: title
  });
  return true;
}

async function updateTargetFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return setTargetTab(tab);
}

function scheduleTargetRefresh() {
  // 眨眼点击可能触发页面跳转。这里做几次延迟刷新，尽量把控制目标切到新页面。
  for (const delay of [150, 500, 1200, 2200]) {
    setTimeout(() => updateTargetFromActiveTab(), delay);
  }
}

async function hasOffscreenDocument() {
  // Manifest V3 的 service worker 不能直接长期使用摄像头，所以摄像头逻辑放在 offscreen document。
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }

  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreen) {
    // USER_MEDIA 是 Chrome 要求的 offscreen reason，说明这个隐藏页会使用摄像头。
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Run camera and MediaPipe face tracking while the control panel is not visible."
    });
  }

  await creatingOffscreen;
  creatingOffscreen = null;
}

async function sendToOffscreen(message) {
  // 所有发给 offscreen.js 的消息都带 target 标记，避免 service worker 自己再次处理。
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function getTargetTabId() {
  const stored = await chrome.storage.local.get({ targetTabId: null });
  return stored.targetTabId;
}

async function ensureContentScript(tabId) {
  try {
    // 有些页面在扩展安装前已经打开，content script 可能还没注入；失败时主动补注入一次。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function sendToTargetTab(message) {
  // 所有 hover/click/scroll 最终都发到目标 tab 的 content-script.js 执行。
  let tabId = await getTargetTabId();
  if (!tabId) {
    await updateTargetFromActiveTab();
    tabId = await getTargetTabId();
  }
  if (!tabId) {
    return false;
  }

  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (firstError) {
    if (!(await ensureContentScript(tabId))) {
      await updateTargetFromActiveTab();
      return false;
    }

    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (secondError) {
      await updateTargetFromActiveTab();
      return false;
    }
  }
}

async function handlePoint(point) {
  const { x, y } = point;
  const now = performance.now();

  if (controlSettings.pointerEnabled && now - lastHoverSentAt > 33) {
    // 限制 hover 发送频率，避免网页消息过密造成卡顿。
    lastHoverSentAt = now;
    await sendToTargetTab({ type: "eye-hover", normalizedX: x, normalizedY: y, visible: true });
  }

  if (!controlSettings.dwellClickEnabled) {
    resetHoverState();
  } else {
    // 驻留点击：如果指示点在小范围内停留足够久，就触发一次点击。
    const screenX = Math.round(x * 1000);
    const screenY = Math.round(y * 1000);
    const movement = Math.hypot(screenX - hoverState.lastX, screenY - hoverState.lastY);
    if (movement > 28) {
      hoverState.startedAt = now;
      hoverState.fired = false;
    }
    hoverState.lastX = screenX;
    hoverState.lastY = screenY;

    if (!hoverState.startedAt) {
      hoverState.startedAt = now;
    }
    if (!hoverState.fired && now - hoverState.startedAt >= controlSettings.dwellMs) {
      hoverState.fired = true;
      await sendToTargetTab({ type: "eye-click", normalizedX: x, normalizedY: y });
      chrome.runtime.sendMessage({ type: "tracker-status", text: "已执行驻留点击" });
      scheduleTargetRefresh();
    }
  }

  if (controlSettings.scrollEnabled && now - lastScrollSentAt >= 320) {
    // 方向滑动：指示点靠近屏幕边缘时，向对应方向滚动页面。
    const edge = 0.18;
    let deltaX = 0;
    let deltaY = 0;
    const speed = controlSettings.scrollSpeed;

    if (x < edge) {
      deltaX = -speed;
    } else if (x > 1 - edge) {
      deltaX = speed;
    }

    if (y < edge) {
      deltaY = -speed;
    } else if (y > 1 - edge) {
      deltaY = speed;
    }

    if (deltaX || deltaY) {
      lastScrollSentAt = now;
      await sendToTargetTab({ type: "eye-scroll", deltaX, deltaY });
    }
  }
}

async function handleBlink(blink) {
  // 眨眼事件由 GazeEngine 做防误触判断，这里只负责把它变成网页点击。
  if (!controlSettings.blinkClickEnabled) {
    return;
  }

  await sendToTargetTab({ type: "eye-click", normalizedX: blink.x, normalizedY: blink.y });
  chrome.runtime.sendMessage({ type: "tracker-status", text: "已执行眨眼点击" });
  scheduleTargetRefresh();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 这个 listener 同时处理控制面板、offscreen、content script 的消息。
  // 异步分支最后 return true，让 Chrome 保留 sendResponse 通道。
  if (message.target === "offscreen") {
    return false;
  }

  (async () => {
    try {
      if (message.type === "control-start") {
        // 控制面板点击“启动”后：更新设置、绑定目标标签页、启动隐藏追踪页。
        controlSettings = { ...controlSettings, ...message.settings };
        resetHoverState();
        await updateTargetFromActiveTab();
        const response = await sendToOffscreen({ type: "tracker-start", config: message.config });
        sendResponse(response || { ok: true });
        return;
      }

      if (message.type === "control-calibrate") {
        const response = await sendToOffscreen({ type: "tracker-calibrate" });
        sendResponse(response || { ok: true });
        return;
      }

      if (message.type === "control-settings") {
        controlSettings = { ...controlSettings, ...message.settings };
        const response = await sendToOffscreen({ type: "tracker-config", config: message.config || {} });
        sendResponse(response || { ok: true });
        return;
      }

      if (message.type === "control-pointer-visible") {
        controlSettings.pointerEnabled = message.visible;
        await sendToTargetTab({ type: "eye-pointer-visible", visible: message.visible });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-point") {
        // offscreen 每帧输出标准化坐标，service worker 决定是否显示指示器、点击或滚动。
        await handlePoint(message.point);
        chrome.runtime.sendMessage({ type: "ui-point", point: message.point });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-blink") {
        await handleBlink(message.blink);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "content-click-dispatched") {
        scheduleTargetRefresh();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message" });
    } catch (error) {
      const text = `${error.name || "Error"} ${error.message || error}`;
      chrome.runtime.sendMessage({ type: "tracker-status", text });
      sendResponse({ ok: false, error: text });
    }
  })();

  return true;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // 用户切换标签页后，把新的活动页面作为控制目标。
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError) {
      setTargetTab(tab);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 页面加载完成或 URL 改变时，也刷新目标，解决点击跳转后仍控制旧页面的问题。
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  chrome.storage.local.get({ targetTabId: null }, ({ targetTabId }) => {
    if (tabId === targetTabId || tab.active) {
      setTargetTab(tab);
    }
  });
});
