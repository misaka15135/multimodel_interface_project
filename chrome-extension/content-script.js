let marker;
let ring;
let dot;
let label;
let actionBadge;
let scrollBadge;
let lastPoint = { x: -100, y: -100 };
let hideScrollTimer;

// content-script.js 会被注入到普通网页里。
// 它不接触摄像头，只负责：
// 1. 在网页上画出类似鼠标的眼控/头控指示器。
// 2. 根据 service worker 发来的坐标执行 hover、click、scroll。
// 3. 点击后通知 service worker，方便它刷新目标标签页。

function px(value) {
  return `${Math.round(value)}px`;
}

function style(el, rules) {
  Object.assign(el.style, rules);
  return el;
}

function ensureMarker() {
  // 指示器懒创建：只有真正收到 hover/click/scroll 消息时才插入 DOM。
  if (marker) {
    return marker;
  }

  marker = style(document.createElement("div"), {
    position: "fixed",
    left: "0",
    top: "0",
    width: "76px",
    height: "76px",
    marginLeft: "-38px",
    marginTop: "-38px",
    pointerEvents: "none",
    // 使用最高 z-index，尽量保证它盖在网页内容之上；pointer-events none 避免挡住点击。
    zIndex: "2147483647",
    opacity: "0",
    transform: "translate(-100px, -100px)",
    transition: "opacity 120ms ease, transform 55ms linear",
    contain: "layout style paint",
    isolation: "isolate"
  });
  marker.setAttribute("data-eye-control-marker", "true");

  ring = style(document.createElement("div"), {
    // 外圈表示当前位置；当下面是可点击元素时会变成绿色。
    position: "absolute",
    inset: "7px",
    border: "3px solid rgba(20,184,166,0.98)",
    borderRadius: "999px",
    background: "rgba(20,184,166,0.08)",
    boxShadow: "0 0 0 9px rgba(20,184,166,0.12), 0 12px 34px rgba(15,23,42,0.28)"
  });

  dot = style(document.createElement("div"), {
    // 中心点用于精确对准点击位置。
    position: "absolute",
    left: "32px",
    top: "32px",
    width: "12px",
    height: "12px",
    borderRadius: "999px",
    background: "#ffffff",
    border: "2px solid rgba(15,23,42,0.72)",
    boxShadow: "0 0 0 2px rgba(20,184,166,0.85)"
  });

  const vertical = style(document.createElement("div"), {
    position: "absolute",
    left: "37px",
    top: "5px",
    width: "2px",
    height: "66px",
    background: "linear-gradient(180deg, transparent, rgba(20,184,166,0.9), transparent)"
  });
  const horizontal = style(document.createElement("div"), {
    position: "absolute",
    left: "5px",
    top: "37px",
    width: "66px",
    height: "2px",
    background: "linear-gradient(90deg, transparent, rgba(20,184,166,0.9), transparent)"
  });

  label = style(document.createElement("div"), {
    // 标签显示当前对准的可点击元素名称，帮助用户确认将要点哪里。
    position: "absolute",
    left: "58px",
    top: "-3px",
    maxWidth: "220px",
    padding: "5px 8px",
    borderRadius: "999px",
    background: "rgba(15,23,42,0.82)",
    color: "#fff",
    font: "12px/1.2 Segoe UI, Microsoft YaHei, sans-serif",
    letterSpacing: "0",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    boxShadow: "0 8px 20px rgba(15,23,42,0.22)"
  });
  label.textContent = "look";

  actionBadge = style(document.createElement("div"), {
    // 点击瞬间的动画反馈。
    position: "absolute",
    left: "26px",
    top: "26px",
    width: "24px",
    height: "24px",
    borderRadius: "999px",
    border: "2px solid rgba(255,255,255,0.98)",
    opacity: "0",
    transform: "scale(1)",
    boxShadow: "0 0 0 0 rgba(34,197,94,0.5)",
    transition: "opacity 120ms ease, transform 180ms ease, box-shadow 260ms ease"
  });

  scrollBadge = style(document.createElement("div"), {
    // 滚动方向反馈，显示 up/down/left/right。
    position: "absolute",
    left: "21px",
    top: "82px",
    minWidth: "34px",
    padding: "4px 8px",
    borderRadius: "999px",
    background: "rgba(14,116,144,0.9)",
    color: "#fff",
    textAlign: "center",
    font: "12px/1 Segoe UI, Microsoft YaHei, sans-serif",
    opacity: "0",
    transition: "opacity 120ms ease"
  });

  marker.append(ring, vertical, horizontal, dot, label, actionBadge, scrollBadge);
  document.documentElement.appendChild(marker);
  return marker;
}

function getPoint(message) {
  // service worker 通常发送 0~1 的标准化坐标，这里换算成当前网页视口像素。
  return {
    x: typeof message.x === "number" ? message.x : Math.round((message.normalizedX || 0) * window.innerWidth),
    y: typeof message.y === "number" ? message.y : Math.round((message.normalizedY || 0) * window.innerHeight)
  };
}

function getTargetLabel(x, y) {
  // 根据当前位置下方的 DOM 元素生成简短标签。
  const target = document.elementFromPoint(x, y);
  if (!target) {
    return "look";
  }

  const clickable = target.closest("a, button, input, select, textarea, summary, [role='button'], [role='link'], [tabindex]");
  if (!clickable) {
    return "look";
  }

  const text = (clickable.getAttribute("aria-label") || clickable.innerText || clickable.value || clickable.tagName || "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 28) : clickable.tagName.toLowerCase();
}

function setPointerState(x, y, visible = true) {
  // 更新指示器位置和颜色。颜色会根据下方是否是按钮/链接等可点击元素变化。
  ensureMarker();
  lastPoint = { x, y };
  marker.style.opacity = visible ? "1" : "0";
  marker.style.transform = `translate(${px(x)}, ${px(y)})`;

  const target = document.elementFromPoint(x, y);
  const clickable = target && target.closest("a, button, input, select, textarea, summary, [role='button'], [role='link'], [tabindex]");
  ring.style.borderColor = clickable ? "rgba(34,197,94,0.98)" : "rgba(20,184,166,0.98)";
  ring.style.background = clickable ? "rgba(34,197,94,0.12)" : "rgba(20,184,166,0.08)";
  dot.style.boxShadow = clickable ? "0 0 0 2px rgba(34,197,94,0.85)" : "0 0 0 2px rgba(20,184,166,0.85)";
  label.textContent = getTargetLabel(x, y);
}

function flashClick() {
  // 点击反馈不会影响真正点击，只是视觉提示。
  ensureMarker();
  actionBadge.style.opacity = "1";
  actionBadge.style.transform = "scale(2.8)";
  actionBadge.style.boxShadow = "0 0 0 18px rgba(34,197,94,0)";
  ring.style.borderColor = "rgba(34,197,94,1)";
  setTimeout(() => {
    actionBadge.style.opacity = "0";
    actionBadge.style.transform = "scale(1)";
    actionBadge.style.boxShadow = "0 0 0 0 rgba(34,197,94,0.5)";
  }, 180);
}

function showScroll(deltaX = 0, deltaY = 0) {
  // 页面滚动时给用户一个方向提示，短时间后自动隐藏。
  ensureMarker();
  const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
  const arrow = horizontal ? (deltaX > 0 ? "right" : "left") : (deltaY > 0 ? "down" : "up");
  scrollBadge.textContent = arrow;
  scrollBadge.style.opacity = "1";
  clearTimeout(hideScrollTimer);
  hideScrollTimer = setTimeout(() => {
    scrollBadge.style.opacity = "0";
  }, 260);
}

function clickAt(x, y) {
  // 用原生 MouseEvent 模拟点击。大多数普通网页会响应；少数复杂站点可能需要更深的适配。
  const target = document.elementFromPoint(x, y);
  if (!target) {
    return;
  }
  flashClick();
  target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  chrome.runtime.sendMessage({ type: "content-click-dispatched" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // service worker 发来的控制消息入口。
  if (message.type === "eye-pointer-visible") {
    ensureMarker();
    marker.style.opacity = message.visible ? "1" : "0";
    sendResponse({ ok: true });
    return;
  }

  const { x, y } = getPoint(message);
  if (message.type === "eye-hover") {
    setPointerState(x, y, message.visible !== false);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "eye-click") {
    setPointerState(x, y, true);
    clickAt(x, y);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "eye-scroll") {
    setPointerState(lastPoint.x, lastPoint.y, true);
    showScroll(message.deltaX || 0, message.deltaY || 0);
    window.scrollBy({
      left: message.deltaX || 0,
      top: message.deltaY || 0,
      behavior: "smooth"
    });
    sendResponse({ ok: true });
  }
});
