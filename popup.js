const openAppButton = document.querySelector("#openAppButton");
const enabledInput = document.querySelector("#enabledInput");
const statusText = document.querySelector("#statusText");

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  enabledInput.checked = enabled;
});

async function rememberCurrentTargetTab() {
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
  await chrome.storage.local.set({ enabled: enabledInput.checked });
  statusText.textContent = enabledInput.checked ? "网页控制已启用" : "网页控制已停用";
});
