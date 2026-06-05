'use strict';

// ============================================================
//  VoiceController — 主控制器 (v0.2)
//  协调 eventBus / actionRegistry / llmClient / speechRecognizer /
//       actionExecutor / uiManager
//  暴露标准化公共 API 供多模态融合使用
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  const bus = exports.eventBus;
  const registry = exports.actionRegistry;
  const llmClient = exports.llmClient;
  const recognizer = exports.speechRecognizer;
  const executor = exports.actionExecutor;
  const ui = exports.uiManager;

  // ============================================================
  //  状态
  // ============================================================
  let apiKey = '';
  let isListening = false;
  let unsubscribers = [];       // 收集所有 eventBus 订阅的函数
  const externalListeners = []; // onEvent 注册的外部回调

  // ============================================================
  //  内部辅助
  // ============================================================

  function toast(msg, type) {
    ui.showToast(msg, type);
  }

  function errorToast(msg) {
    ui.showToast(`<span class="toast-error">${msg}</span>`, 'error');
  }

  function setMic(state) {
    ui.setMicState(state);
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
    } catch (_) { /* ignore */ }
  }

  async function saveApiKey(key) {
    if (!key) return;
    apiKey = key;
    llmClient.setApiKey(key);
    try {
      await chrome.storage.local.set({ voice_ext_apikey: key });
    } catch (_) { /* ignore */ }
    ui.hideSettings();
    toast('API Key 已保存');
  }

  // ============================================================
  //  语音处理核心流程
  // ============================================================

  async function handleSpeechResult(data) {
    const { transcript, confidence } = data;

    toast(`识别: "${transcript}"`);

    if (!apiKey) {
      errorToast('请先设置 API Key');
      ui.showSettings();
      setMic('idle');
      isListening = false;
      recognizer.stop();
      return;
    }

    setMic('processing');
    try {
      const intent = await llmClient.interpret(transcript);
      const info = await executor.execute(intent, { transcript, confidence });

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
        toast(info.ok
          ? `"${transcript}" → <span class="toast-action">点赞</span>`
          : `"${transcript}" → 未找到点赞按钮`);
      } else {
        const labels = {
          scroll_up: '向上滚动', scroll_down: '向下滚动',
          scroll_to_top: '回到顶部', scroll_to_bottom: '滚动到底部',
          refresh: '刷新页面', go_back: '后退', go_forward: '前进',
          stop_listening: '已停止监听',
        };
        toast(`"${transcript}" → <span class="toast-action">${labels[intent.action] || intent.action}</span>`);
      }

      // —— 通知外部监听器（多模态融合） ——
      if (intent.action !== 'none') {
        notifyExternal(intent, info, { transcript, confidence });
      }
    } catch (err) {
      setMic('error');
      errorToast(err.message);
      setTimeout(() => {
        if (isListening) setMic('listening');
        else setMic('idle');
      }, 2000);
    }

    // recognizer 自动 restart，只需恢复 UI 状态
    if (isListening) {
      setMic('listening');
    }
  }

  /** 通知所有通过 onEvent 注册的外部监听器 */
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
  //  麦克风切换
  // ============================================================

  function startListening() {
    if (!apiKey) {
      ui.showSettings();
      errorToast('请先设置 API Key');
      return;
    }

    // 确保 SpeechRecognition 已初始化（需在用户手势后）
    if (!recognizer.init()) {
      errorToast('浏览器不支持语音识别');
      return;
    }

    isListening = true;
    setMic('listening');
    recognizer.start();
    toast('正在监听...');
  }

  function stopListening() {
    isListening = false;
    setMic('idle');
    recognizer.stop();
    toast('语音控制已停止');
  }

  function toggleMic() {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }

  // ============================================================
  //  事件绑定
  // ============================================================

  function bindEvents() {
    const sub = (event, handler) => {
      unsubscribers.push(bus.on(event, handler));
    };

    // UI 事件
    sub('ui:mic_clicked', toggleMic);
    sub('ui:gear_clicked', () => ui.toggleSettings());
    sub('ui:save_apikey', (data) => saveApiKey(data.key));
    sub('ui:cancel_settings', () => {
      ui.setApiKeyInput(apiKey); // 恢复原值
      ui.hideSettings();
    });
    sub('ui:click_outside', () => ui.hideSettings());

    // 语音事件
    sub('speech:result', handleSpeechResult);
    sub('speech:error', (data) => {
      if (data.silent) return;
      setMic('error');
      errorToast(`识别错误: ${data.error}`);
      setTimeout(() => {
        if (isListening) setMic('listening');
        else setMic('idle');
      }, 2000);
    });
    sub('speech:start', () => {
      if (isListening) setMic('listening');
    });
    sub('speech:stop', () => {
      if (!isListening) setMic('idle');
    });

    // 停止监听请求
    sub('voice:stop_requested', () => {
      stopListening();
    });

    // 动作执行事件 — 可记录日志
    sub('action:executed', (data) => {
      console.log('[VoiceExt] action executed:', data.action,
        data.result?.ok ? '✓' : '✗',
        data.result?.reason || '');
    });
  }

  // ============================================================
  //  公开 API
  // ============================================================

  const controller = {

    /** 初始化所有模块 */
    async init() {
      ui.inject();
      bindEvents();
      await loadApiKey();
      console.log('[VoiceExt] Controller initialized —',
        'actions:', registry.list().join(', '));
    },

    /** 销毁所有资源 */
    dispose() {
      stopListening();
      recognizer.dispose();
      for (const unsub of unsubscribers) unsub();
      unsubscribers = [];
      externalListeners.length = 0;
      ui.dispose();
      registry.clear();
      bus.removeAll();
      console.log('[VoiceExt] Controller disposed');
    },

    /** 开始语音监听 */
    startListening,

    /** 停止语音监听 */
    stopListening,

    /**
     * 执行动作（供外部多模态模块调用）
     * @param {string} actionName
     * @param {object} params
     * @returns {Promise<object>}
     */
    async executeAction(actionName, params = {}) {
      return await executor.execute(
        { action: actionName, ...params },
        { source: 'external' }
      );
    },

    /**
     * 订阅语音事件（供多模态融合）
     * @param {Function} callback — (event) => void
     *    event: { source, action, params, confidence, timestamp, raw }
     * @returns {Function} 取消订阅
     */
    onEvent(callback) {
      externalListeners.push(callback);
      return () => {
        const idx = externalListeners.indexOf(callback);
        if (idx >= 0) externalListeners.splice(idx, 1);
      };
    },

    /** 获取当前状态 */
    getState() {
      return {
        isListening,
        hasApiKey: !!apiKey,
        registeredActions: registry.list(),
        actionCount: registry.list().length,
        version: '0.2.0',
      };
    },
  };

  // ============================================================
  //  暴露到全局
  // ============================================================
  exports.controller = controller;

  // 自动启动
  controller.init().then(() => {
    console.log('[VoiceExt] 声控助手 v0.2 已就绪 — 点击右下角按钮开始');
  });

})(window.VoiceExt);
