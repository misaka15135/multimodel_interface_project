'use strict';

// ============================================================
//  融合控制中心 — popup.js
// ============================================================

const eyeOpenBtn = document.getElementById('eye-open-btn');
const eyeStatusText = document.getElementById('eye-status-text');
const gestureStatusText = document.getElementById('gesture-status-text');
const voiceStatusText = document.getElementById('voice-status-text');
const dotEye = document.getElementById('dot-eye');
const dotGesture = document.getElementById('dot-gesture');
const dotVoice = document.getElementById('dot-voice');
const ctxPointer = document.getElementById('ctx-pointer');
const ctxGaze = document.getElementById('ctx-gaze');
const ctxCommand = document.getElementById('ctx-command');

// ============================================================
//  初始化：读取存储状态
// ============================================================

async function init() {
  // 眼动状态
  const { enabled: eyeEnabled } = await chrome.storage.local.get({ enabled: true });
  updateEyeUI(eyeEnabled);

  // 检查是否有 target tab（眼动是否在运行）
  const { targetTabId, targetTabTitle } = await chrome.storage.local.get({
    targetTabId: null,
    targetTabTitle: null
  });
  if (targetTabId) {
    eyeStatusText.textContent = '运行中 → ' + (targetTabTitle || targetTabId);
    dotEye.className = 'status-dot active';
    dotEye.title = '眼动运行中';
  }
}

function updateEyeUI(enabled) {
  if (enabled && eyeStatusText.textContent.includes('运行中')) return;
  dotEye.className = 'status-dot ' + (enabled ? 'active' : 'idle');
  dotEye.title = enabled ? '眼动运行中' : '眼动未启动';
  eyeStatusText.textContent = enabled ? '网页控制已启用' : '未启动';
}

// ============================================================
//  眼动：打开控制窗口
// ============================================================

eyeOpenBtn.addEventListener('click', async () => {
  // 记住当前活跃标签作为控制目标
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id && /^https?:\/\//.test(tab.url || '')) {
    await chrome.storage.local.set({
      targetTabId: tab.id,
      targetTabTitle: tab.title || tab.url || '当前标签页'
    });
  }

  const width = 430;
  const height = 690;
  const left = Math.max(0, Math.round((screen.availLeft || 0) + screen.availWidth - width - 18));
  const top = Math.max(0, Math.round((screen.availTop || 0) + screen.availHeight - height - 18));

  await chrome.windows.create({
    url: chrome.runtime.getURL('eye/app.html'),
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true
  });

  eyeStatusText.textContent = '控制窗口已打开';
  dotEye.className = 'status-dot active';
  dotEye.title = '眼动控制窗口已打开';
});

// ============================================================
//  监听来自 eye service worker 的状态更新
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'tracker-status') {
    eyeStatusText.textContent = message.text || '运行中';
    dotEye.className = 'status-dot active';
    dotEye.title = '眼动: ' + (message.text || '运行中');
  }
  if (message.type === 'target-tab-changed') {
    eyeStatusText.textContent = '运行中 → ' + (message.targetTabTitle || '');
    dotEye.className = 'status-dot active';
  }
});

// ============================================================
//  定时轮询融合上下文（通过注入脚本读取页面 MMFusion 状态）
// ============================================================

async function pollFusionContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https?:\/\//.test(tab.url || '')) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const fusion = window.MMFusion;
        if (!fusion) return null;
        const ctx = fusion.getContext();
        return {
          pointer: ctx.pointerTarget,
          gaze: ctx.gazeTarget,
          lastCommand: ctx.lastCommand,
        };
      },
      world: 'MAIN',  // MMFusion 在 MAIN world 也有实例
    });

    if (results && results[0] && results[0].result) {
      const ctx = results[0].result;
      if (ctx.pointer) {
        const p = ctx.pointer.point || {};
        ctxPointer.textContent = `(${Math.round(p.x || 0)}, ${Math.round(p.y || 0)})`;
      } else {
        ctxPointer.textContent = '—';
      }
      if (ctx.gaze) {
        const g = ctx.gaze.point || {};
        ctxGaze.textContent = `(${Math.round(g.x || 0)}, ${Math.round(g.y || 0)})`;
      } else {
        ctxGaze.textContent = '—';
      }
      if (ctx.lastCommand) {
        ctxCommand.textContent = `${ctx.lastCommand.action || '?'} (${ctx.lastCommand.source || '?'})`;
      } else {
        ctxCommand.textContent = '—';
      }
    }
  } catch (_) {
    // 页面可能还没加载 content script
  }
}

// 弹窗打开时立即轮询一次
init();
pollFusionContext();

// 每 1.5s 刷新融合状态
setInterval(pollFusionContext, 1500);
