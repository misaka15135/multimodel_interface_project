const OFFSCREEN_URL = "eye/offscreen.html";

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
  chrome.storage.local.set({ enabled: true });
});

function isControllableUrl(url = "") {
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
  for (const delay of [150, 500, 1200, 2200]) {
    setTimeout(() => updateTargetFromActiveTab(), delay);
  }
}

async function hasOffscreenDocument() {
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
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function getTargetTabId() {
  const stored = await chrome.storage.local.get({ targetTabId: null });
  return stored.targetTabId;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["eye/content-script.js"]
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function sendToTargetTab(message) {
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
    lastHoverSentAt = now;
    await sendToTargetTab({ type: "eye-hover", normalizedX: x, normalizedY: y, visible: true });
  }

  if (!controlSettings.dwellClickEnabled) {
    resetHoverState();
  } else {
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
  if (!controlSettings.blinkClickEnabled) {
    return;
  }

  await sendToTargetTab({ type: "eye-click", normalizedX: blink.x, normalizedY: blink.y });
  chrome.runtime.sendMessage({ type: "tracker-status", text: "已执行眨眼点击" });
  scheduleTargetRefresh();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "offscreen") {
    return false;
  }

  (async () => {
    try {
      if (message.type === "control-start") {
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
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError) {
      setTargetTab(tab);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  chrome.storage.local.get({ targetTabId: null }, ({ targetTabId }) => {
    if (tabId === targetTabId || tab.active) {
      setTargetTab(tab);
    }
  });
});
