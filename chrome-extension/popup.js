const openAppButton = document.querySelector("#openAppButton");
const enabledInput = document.querySelector("#enabledInput");
const statusText = document.querySelector("#statusText");

// popup.js 运行在 Chrome 工具栏的小弹窗里。
// 它只负责打开右下角控制窗口，并把当前网页记为控制目标。
// 不在这里运行摄像头，因为工具栏 popup 一失焦就会被 Chrome 关闭。

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  enabledInput.checked = enabled;
});

async function rememberCurrentTargetTab() {
  // 打开控制窗口前，先记住用户当前所在网页，后续 hover/click/scroll 都发到这个 tab。
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:\/\//.test(tab.url || "")) {
    return;
  }

  await chrome.storage.local.set({
    targetTabId: tab.id,
    targetTabTitle: tab.title || tab.url || "当前标签页"
  });
}

openAppButton.addEventListener("click", async () => {
  // 控制窗口放到屏幕右下角，宽高保持较小，用户可以一边看网页一边调参数。
  await rememberCurrentTargetTab();

  const width = 430;
  const height = 690;
  const left = Math.max(0, Math.round((screen.availLeft || 0) + screen.availWidth - width - 18));
  const top = Math.max(0, Math.round((screen.availTop || 0) + screen.availHeight - height - 18));

  await chrome.windows.create({
    url: chrome.runtime.getURL("app.html"),
    type: "popup",
    width,
    height,
    left,
    top,
    focused: true
  });
  statusText.textContent = "控制窗口已打开";
});

enabledInput.addEventListener("change", async () => {
  // 预留的总开关。当前主要记录状态，后续可在 service worker 中加入强制拦截。
  await chrome.storage.local.set({ enabled: enabledInput.checked });
  statusText.textContent = enabledInput.checked ? "网页控制已启用" : "网页控制已停用";
});
