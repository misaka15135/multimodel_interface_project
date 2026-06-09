// 幂等守卫：manifest 已注入，防止 service-worker 的 ensureContentScript 二次注入
if (window.__eyeContentScriptInjected) return;
window.__eyeContentScriptInjected = true;

let marker;
let ring;
let dot;
let label;
let actionBadge;
let scrollBadge;
let lastPoint = { x: -100, y: -100 };
let hideScrollTimer;

function px(value) {
  return `${Math.round(value)}px`;
}

function style(el, rules) {
  Object.assign(el.style, rules);
  return el;
}

function ensureMarker() {
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
    zIndex: "2147483647",
    opacity: "0",
    transform: "translate(-100px, -100px)",
    transition: "opacity 120ms ease, transform 55ms linear",
    contain: "layout style paint",
    isolation: "isolate"
  });
  marker.setAttribute("data-eye-control-marker", "true");

  ring = style(document.createElement("div"), {
    position: "absolute",
    inset: "7px",
    border: "3px solid rgba(20,184,166,0.98)",
    borderRadius: "999px",
    background: "rgba(20,184,166,0.08)",
    boxShadow: "0 0 0 9px rgba(20,184,166,0.12), 0 12px 34px rgba(15,23,42,0.28)"
  });

  dot = style(document.createElement("div"), {
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
  return {
    x: typeof message.x === "number" ? message.x : Math.round((message.normalizedX || 0) * window.innerWidth),
    y: typeof message.y === "number" ? message.y : Math.round((message.normalizedY || 0) * window.innerHeight)
  };
}

function getTargetLabel(x, y) {
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
