'use strict';

// ============================================================
//  VoiceController — 主控制器 (v0.3)
//  ★ 唤醒词状态机：PASSIVE → ACTIVE → PASSIVE
//  ★ 连续对话模式
//  ★ TTS 语音反馈协调
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  const bus = exports.eventBus;
  const registry = exports.actionRegistry;
  const llmClient = exports.llmClient;
  const recognizer = exports.speechRecognizer;
  const executor = exports.actionExecutor;
  const tts = exports.ttsManager;
  const ui = exports.uiManager;

  // ============================================================
  //  配置
  // ============================================================
  const WAKE_WORD = '小助手';
  const ACTIVE_TIMEOUT = 10000;    // 10秒无命令回到PASSIVE

  // ============================================================
  //  状态
  // ============================================================
  let apiKey = '';
  let mode = 'idle';               // 'idle' | 'passive' | 'active'
  let wakeEnabled = true;
  let activeTimer = null;
  let unsubscribers = [];
  const externalListeners = [];

  // ============================================================
  //  内部辅助
  // ============================================================

  function toast(msg, type) { ui.showToast(msg, type); }
  function errorToast(msg) { ui.showToast(`<span class="toast-error">${msg}</span>`, 'error'); }

  /** 切换到指定模式 */
  function setMode(newMode) {
    mode = newMode;
    const modeMap = { idle: 'idle', passive: 'passive', active: 'active' };
    const uiMode = { idle: 'off', passive: 'passive', active: 'active' };

    ui.setMicState(modeMap[newMode] || 'idle');
    ui.setMode(uiMode[newMode] || 'off');
  }

  /** 重置 ACTIVE 超时计时器 */
  function resetActiveTimer() {
    if (activeTimer) clearTimeout(activeTimer);
    if (mode === 'active' && wakeEnabled) {
      activeTimer = setTimeout(() => {
        if (mode === 'active') {
          setMode('passive');
          tts.playChime('deactivate');
          toast('已进入待机，说"小助手"唤醒');
        }
      }, ACTIVE_TIMEOUT);
    }
  }

  // ============================================================
  //  API Key 持久化
  // ============================================================

  async function loadApiKey() {
    try {
      const result = await chrome.storage.local.get('voice_ext_apikey');
      if (result.voice_ext_apikey) {
        apiKey = result.voice_ext_apikey;
        llmClient.setApiKey(apiKey);
        ui.setApiKeyInput(apiKey);
      }
    } catch (_) {}
  }

  async function saveApiKey(key) {
    if (!key) return;
    apiKey = key;
    llmClient.setApiKey(key);
    try { await chrome.storage.local.set({ voice_ext_apikey: key }); } catch (_) {}
    ui.hideSettings();
    toast('API Key 已保存');
  }

  // ============================================================
  //  语音处理核心流程（v0.3 唤醒词版）
  // ============================================================

  async function handleSpeechResult(data) {
    const { transcript, confidence } = data;

    // ====== 唤醒词检测 ======
    if (wakeEnabled) {
      // 检查是否包含唤醒词
      const wakeIndex = transcript.indexOf(WAKE_WORD);

      if (mode === 'idle' || mode === 'passive') {
        if (wakeIndex >= 0) {
          // 唤醒！
          setMode('active');
          tts.playChime('activate');
          resetActiveTimer();

          // 提取唤醒词之后的命令文本
          const after = transcript.slice(wakeIndex + WAKE_WORD.length).trim();
          if (after.length > 0) {
            // 有附带命令："小助手往下滚动"
            toast(`已唤醒，执行: "${after}"`);
            await processCommand(after, confidence);
          } else {
            // 纯唤醒
            toast('我在听，请说指令...');
          }
          return;
        }
        // PASSIVE 模式下忽略非唤醒词语音
        if (mode === 'passive') return;
        // IDLE 模式下也不处理（idle = 未点击麦克风）
        return;
      }

      // ACTIVE 模式下检测再次提到唤醒词，重置计时器
      if (mode === 'active' && wakeIndex >= 0) {
        resetActiveTimer();
        const after = transcript.slice(wakeIndex + WAKE_WORD.length).trim();
        if (after.length > 0) {
          toast(`执行: "${after}"`);
          await processCommand(after, confidence);
          return;
        }
        toast('在呢，请说指令...');
        return;
      }
    }

    // ====== 命令处理 ======
    if (mode === 'active') {
      resetActiveTimer();
      await processCommand(transcript, confidence);
      return;
    }

    // 直接监听模式（唤醒词关闭时）
    if (!wakeEnabled && (mode === 'active' || mode === 'passive')) {
      await processCommand(transcript, confidence);
    }
  }

  async function processCommand(transcript, confidence) {
    toast(`识别: "${transcript}"`);

    if (!apiKey) {
      errorToast('请先设置 API Key');
      ui.showSettings();
      return;
    }

    ui.setMicState('processing');
    try {
      const intent = await llmClient.interpret(transcript);
      const info = await executor.execute(intent, { transcript, confidence });

      // —— TTS 反馈 ——
      if (intent.action !== 'none' && intent.action !== 'read_page' && intent.action !== 'stop_reading') {
        tts.speak(intent.action);
      }

      // —— Toast 反馈 ——
      if (intent.action === 'none') {
        toast(`"${transcript}" — 未执行 (${intent.reason || '无法识别'})`);
      } else if (intent.action === 'comment') {
        if (info.ok) {
          toast(`"${transcript}" → <span class="toast-action">评论: ${info.text}</span><br><small>${info.reason}</small>`);
        } else {
          errorToast(`评论失败: ${info.reason || '未知'}`);
        }
      } else if (intent.action === 'like') {
        toast(info.ok ? `"${transcript}" → <span class="toast-action">点赞</span>` : `"${transcript}" → 未找到点赞按钮`);
      } else if (intent.action === 'find') {
        toast(info.ok ? `<span class="toast-action">${info.reason}</span>` : `未找到`);
      } else if (intent.action === 'read_page') {
        toast(info.ok ? `"${transcript}" → <span class="toast-action">开始朗读</span>` : errorToast(info.reason));
      } else {
        const labels = {
          scroll_up: '向上滚动', scroll_down: '向下滚动',
          scroll_to_top: '回到顶部', scroll_to_bottom: '滚动到底部',
          refresh: '刷新页面', go_back: '后退', go_forward: '前进',
          zoom_in: '放大', zoom_out: '缩小', zoom_reset: '恢复缩放',
          tab_new: '新标签页',
          stop_listening: '已停止监听', stop_reading: '已停止朗读',
        };
        toast(`"${transcript}" → <span class="toast-action">${labels[intent.action] || intent.action}</span>`);
      }

      // —— 通知外部（多模态融合） ——
      if (intent.action !== 'none') {
        notifyExternal(intent, info, { transcript, confidence });
      }
    } catch (err) {
      tts.playChime('error');
      ui.setMicState('error');
      errorToast(err.message);
      setTimeout(() => {
        if (mode === 'active') setMode('active');
        else if (mode === 'passive') setMode('passive');
        else ui.setMicState('idle');
      }, 2000);
    }

    // 恢复 UI
    if (mode === 'active') {
      setMode('active');
    } else if (mode === 'passive') {
      setMode('passive');
    } else {
      ui.setMicState('idle');
    }
  }

  function notifyExternal(intent, result, context) {
    const { action, ...params } = intent;
    const event = {
      source: 'voice',
      action,
      params,
      confidence: context.confidence || 0.95,
      timestamp: Date.now(),
      raw: { transcript: context.transcript },
    };
    for (const fn of externalListeners) {
      try { fn(event); } catch (e) { console.error('[VoiceExt] external listener error:', e); }
    }
  }

  // ============================================================
  //  麦克风控制
  // ============================================================

  function startListening() {
    if (!apiKey) { ui.showSettings(); errorToast('请先设置 API Key'); return; }
    if (!recognizer.init()) { errorToast('浏览器不支持语音识别'); return; }

    if (wakeEnabled) {
      setMode('passive');
      toast('待机中，说"小助手"唤醒...');
    } else {
      setMode('active');
      toast('正在监听...');
    }
    recognizer.start();
  }

  function stopListening() {
    if (activeTimer) clearTimeout(activeTimer);
    setMode('idle');
    recognizer.stop();
    toast('语音控制已停止');
  }

  function toggleMic() {
    if (mode !== 'idle') { stopListening(); }
    else { startListening(); }
  }

  // ============================================================
  //  事件绑定
  // ============================================================

  function bindEvents() {
    const sub = (e, h) => { unsubscribers.push(bus.on(e, h)); };

    // UI
    sub('ui:mic_clicked', toggleMic);
    sub('ui:gear_clicked', () => ui.toggleSettings());
    sub('ui:save_apikey', (d) => saveApiKey(d.key));
    sub('ui:cancel_settings', () => { ui.setApiKeyInput(apiKey); ui.hideSettings(); });
    sub('ui:click_outside', () => ui.hideSettings());
    sub('ui:tts_toggled', (d) => { tts.setEnabled(d.enabled); ui.setTtsEnabled(d.enabled); });
    sub('ui:wake_toggled', (d) => {
      wakeEnabled = d.enabled;
      if (!wakeEnabled && mode === 'passive') {
        setMode('active');
        toast('唤醒词已关闭，直接说指令');
      } else if (wakeEnabled && mode === 'active') {
        setMode('passive');
        toast('唤醒词已开启，说"小助手"激活');
      }
    });

    // 语音
    sub('speech:result', handleSpeechResult);
    sub('speech:error', (d) => {
      if (d.silent) return;
      ui.setMicState('error');
      errorToast(`识别错误: ${d.error}`);
      setTimeout(() => {
        if (mode !== 'idle') setMode(mode);
        else ui.setMicState('idle');
      }, 2000);
    });

    // 停止
    sub('voice:stop_requested', stopListening);

    // TTS 期间暂停/恢复识别
    sub('voice:pause_recognition', () => recognizer.pause());
    sub('voice:resume_recognition', () => { if (mode !== 'idle') recognizer.resume(); });

    // 日志
    sub('action:executed', (d) => {
      console.log('[VoiceExt]', d.action, d.result?.ok ? '✓' : '✗', d.result?.reason || '');
    });
  }

  // ============================================================
  //  公开 API
  // ============================================================

  const controller = {

    async init() {
      tts.init();
      ui.inject();
      bindEvents();
      await loadApiKey();
      ui.setTtsEnabled(tts.isEnabled());
      ui.setWakeEnabled(wakeEnabled);
      console.log('[VoiceExt] Controller v0.3 initialized —',
        registry.list().length, 'actions, wake word:', WAKE_WORD);
    },

    dispose() {
      stopListening();
      tts.stop();
      recognizer.dispose();
      for (const u of unsubscribers) u();
      unsubscribers = [];
      externalListeners.length = 0;
      ui.dispose();
      registry.clear();
      bus.removeAll();
      console.log('[VoiceExt] Controller disposed');
    },

    startListening,
    stopListening,

    async executeAction(actionName, params = {}) {
      return await executor.execute({ action: actionName, ...params }, { source: 'external' });
    },

    onEvent(callback) {
      externalListeners.push(callback);
      return () => { const i = externalListeners.indexOf(callback); if (i >= 0) externalListeners.splice(i, 1); };
    },

    getState() {
      return {
        mode,
        wakeEnabled,
        ttsEnabled: tts.isEnabled(),
        hasApiKey: !!apiKey,
        wakeWord: WAKE_WORD,
        actions: registry.list(),
        version: '0.3.0',
      };
    },
  };

  exports.controller = controller;

  // 自动启动
  controller.init().then(() => {
    // 设置 TTS 暂停回调：朗读时暂停识别
    recognizer.onShouldPause = () => tts.isSpeaking();
    console.log('[VoiceExt] 声控助手 v0.3 已就绪 — 点击右下角按钮开始');
  });

})(window.VoiceExt);
