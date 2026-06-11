'use strict';

// ============================================================
//  VoiceController — 主控制器
//  ★ 混合意图引擎：本地匹配优先，LLM 仅兜底
//  ★ 上下文记忆：追问 / 撤销 / 重复
//  ★ 鲁棒性：去重、置信度门、危险动作确认、LLM 失败优雅降级
//  ★ 多模态融合：发布命令到 MMFusion，"点这个"从手势/眼动解析目标
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
  const intentMatcher = exports.intentMatcher;
  const contextManager = exports.contextManager;
  const fusion = window.MMFusion || null;   // 融合总线（独立于 VoiceExt 命名空间）

  // ============================================================
  //  配置
  // ============================================================
  const WAKE_WORD = '小助手';
  const ACTIVE_TIMEOUT = 10000;    // 10秒无命令回到PASSIVE
  const LOCK_REFRESH_MS = 5000;    // 锁刷新间隔
  const LOCK_STALE_MS = 15000;     // 锁过期时间
  const TAB_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const DEDUP_MS = 1500;           // 同一句识别去重窗口
  const CONF_MIN = 0.45;           // 置信度下限（仅当上报了 >0 的值时才生效）
  const CONFIRM_TIMEOUT = 8000;    // 危险动作待确认超时

  // ============================================================
  //  状态
  // ============================================================
  let apiKey = '';
  let mode = 'idle';               // 'idle' | 'passive' | 'active'
  let wakeEnabled = false;         // 默认关闭唤醒词
  let activeTimer = null;
  let lockInterval = null;
  let unsubscribers = [];
  const externalListeners = [];

  // 鲁棒性状态
  let lastTranscript = '';
  let lastTranscriptTs = 0;
  let pendingConfirm = null;       // { intent, undo, label } —— 等待"是/确认"
  let confirmTimer = null;
  let lastSpeechErrorKey = '';
  let lastSpeechErrorTs = 0;

  // 同时启动时的竞态保护标志
  let _acquiring = false;
  let _startingAborted = false;

  // BroadcastChannel：跨标签即时通信，不存在读写竞态
  const _channel = (() => {
    try { return new BroadcastChannel('voice-ext-exclusive-v3'); } catch (_) { return null; }
  })();

  function _handleChannelMessage(e) {
    if (!e.data || e.data.tabId === TAB_ID) return;
    if (e.data.type !== 'activate') return;

    if (mode !== 'idle') {
      // 我已激活，对方新激活 → 我让出
      if (activeTimer) clearTimeout(activeTimer);
      setMode('idle');
      recognizer.stop();
      releaseLock();
      toast('已在其他标签页启动声控助手');
    } else if (_acquiring) {
      // 双方同时启动 → TAB_ID 字典序小的赢（先创建的赢）
      if (TAB_ID > e.data.tabId) {
        _startingAborted = true;
      }
    }
  }

  // ============================================================
  //  标签页互斥锁（同一时间只有一个标签页能用声控助手）
  // ============================================================

  async function acquireLock() {
    try {
      const data = await chrome.storage.session.get(['voice_active_lock', 'voice_lock_time']);
      if (data.voice_active_lock && data.voice_active_lock !== TAB_ID) {
        const elapsed = Date.now() - (data.voice_lock_time || 0);
        if (elapsed < LOCK_STALE_MS) {
          return false; // 另一个标签页正在使用
        }
        // 锁过期，抢占
      }
      await chrome.storage.session.set({
        voice_active_lock: TAB_ID,
        voice_lock_time: Date.now()
      });
      // 回读验证：防止两个标签页同时写入的竞态
      const verify = await chrome.storage.session.get('voice_active_lock');
      if (verify.voice_active_lock !== TAB_ID) {
        return false; // 另一标签页的写操作抢赢了
      }
      // BroadcastChannel 判定我方输（同时启动时）
      if (_startingAborted) return false;
      // 定期续期
      if (lockInterval) clearInterval(lockInterval);
      lockInterval = setInterval(async () => {
        try {
          const cur = await chrome.storage.session.get('voice_active_lock');
          if (cur.voice_active_lock === TAB_ID) {
            await chrome.storage.session.set({ voice_lock_time: Date.now() });
          }
        } catch (_) {}
      }, LOCK_REFRESH_MS);
      return true;
    } catch (_) { return !_startingAborted; /* session storage 不可用时看竞态结果 */ }
  }

  async function releaseLock() {
    if (lockInterval) { clearInterval(lockInterval); lockInterval = null; }
    try {
      const cur = await chrome.storage.session.get('voice_active_lock');
      if (cur.voice_active_lock === TAB_ID) {
        await chrome.storage.session.remove(['voice_active_lock', 'voice_lock_time']);
      }
    } catch (_) {}
  }

  // ============================================================
  //  内部辅助
  // ============================================================

  function toast(msg, type) { ui.showToast(msg, type); }
  function errorToast(msg) { ui.showToast(`<span class="toast-error">${msg}</span>`, 'error'); }

  function getSpeechErrorMessage(d) {
    if (d && d.message) return d.message;
    const error = d && d.error;
    if (error === 'no-speech') return 'No speech detected. Check the microphone level and speak again.';
    if (error === 'network') return 'Speech recognition network error. The browser speech service may be unreachable.';
    if (error === 'audio-capture') return 'No microphone input captured. Check the selected input device.';
    if (error === 'not-allowed' || error === 'service-not-allowed') return 'Microphone or speech service permission was denied.';
    if (error === 'start-failed') return 'Failed to start speech recognition.';
    if (error === 'no-match') return 'Speech was heard, but no text result was produced.';
    return `Speech recognition error: ${error || 'unknown'}`;
  }

  function shouldThrottleSpeechError(d) {
    const now = Date.now();
    const key = `${d.error || 'unknown'}:${!!d.retrying}`;
    const quietMs = d.retrying ? 5000 : 2000;
    if (key === lastSpeechErrorKey && now - lastSpeechErrorTs < quietMs) return true;
    lastSpeechErrorKey = key;
    lastSpeechErrorTs = now;
    return false;
  }

  /** 切换到指定模式 */
  function setMode(newMode) {
    mode = newMode;
    const modeMap = { idle: 'idle', passive: 'passive', active: 'active' };
    const uiMode = { idle: 'off', passive: 'passive', active: 'active' };

    ui.setMicState(modeMap[newMode] || 'idle');
    ui.setMode(uiMode[newMode] || 'off');
  }

  /** 处理结束后把麦克风 UI 恢复到当前模式 */
  function restoreMicUi() {
    if (mode === 'active') setMode('active');
    else if (mode === 'passive') setMode('passive');
    else ui.setMicState('idle');
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
  //  语音处理核心流程（唤醒词 + 混合引擎）
  // ============================================================

  async function handleSpeechResult(data) {
    const { transcript, confidence } = data;

    // ====== 唤醒词检测 ======
    if (wakeEnabled) {
      const wakeIndex = transcript.indexOf(WAKE_WORD);

      if (mode === 'idle' || mode === 'passive') {
        if (wakeIndex >= 0) {
          setMode('active');
          tts.playChime('activate');
          resetActiveTimer();

          const after = transcript.slice(wakeIndex + WAKE_WORD.length).trim();
          if (after.length > 0) {
            toast(`已唤醒，执行: "${after}"`);
            await processCommand(after, confidence);
          } else {
            toast('我在听，请说指令...');
          }
          return;
        }
        if (mode === 'passive') return;
        return;
      }

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

    if (!wakeEnabled && (mode === 'active' || mode === 'passive')) {
      await processCommand(transcript, confidence);
    }
  }

  // ============================================================
  //  混合意图处理管线
  // ============================================================

  async function processCommand(transcript, confidence) {
    const now = Date.now();

    // (0) 去重：同一句 1.5s 内重复 → 忽略（Web Speech 偶尔双触发）
    if (transcript === lastTranscript && now - lastTranscriptTs < DEDUP_MS) return;
    lastTranscript = transcript;
    lastTranscriptTs = now;

    // (1) 待确认优先
    if (pendingConfirm) {
      const fu = intentMatcher.match(transcript);
      if (fu && fu.action === '__followup__' && fu.kind === 'confirm') {
        const pc = pendingConfirm; clearPendingConfirm();
        toast(`已确认，执行「${pc.label}」`);
        return await runIntent(pc.intent, pc.undo, transcript, confidence);
      }
      if (fu && fu.action === '__followup__' && fu.kind === 'cancel') {
        clearPendingConfirm();
        toast('已取消');
        return;
      }
      // 其它话语：取消旧确认，按新指令继续处理
      clearPendingConfirm();
    }

    // (2) 置信度门：仅当上报了 >0 的低置信度时才拦截
    //     （Web Speech zh-CN 经常对正常结果上报 confidence=0，故 0/undefined 绝不拦截）
    if (typeof confidence === 'number' && confidence > 0 && confidence < CONF_MIN) {
      tts.playChime('error');
      toast('没听清，请再说一遍');
      return;
    }

    toast(`识别: "${transcript}"`);

    // (3) 本地匹配
    let intent = intentMatcher.match(transcript);

    // (3a) 追问/控制
    if (intent && intent.action === '__followup__') {
      if (intent.kind === 'undo') {
        const u = contextManager.popUndo();
        if (!u) { toast('没有可撤销的操作'); return; }
        try { u.undoFn(); toast(`已撤销：${u.label}`); }
        catch (_) { errorToast('撤销失败'); }
        return;
      }
      if (intent.kind === 'repeat_last' || intent.kind === 'repeat_dir') {
        const resolved = contextManager.resolveFollowup(intent.kind);
        if (!resolved) { toast('没有可重复的指令'); return; }
        intent = resolved;  // 继续走确认/撤销/执行
      } else if (intent.kind === 'confirm' || intent.kind === 'cancel') {
        toast('没有待确认的操作');
        return;
      }
    }

    // (3b) LLM 兜底
    if (!intent) {
      if (!apiKey) { errorToast('请先设置 API Key'); ui.showSettings(); return; }
      ui.setMicState('processing');
      try {
        intent = await llmClient.interpret(transcript);
        intent.source = 'llm';
      } catch (err) {
        // 本地没命中 + LLM 出错 → 优雅降级，不崩
        tts.playChime('error');
        errorToast('暂时无法理解该指令，请换种说法');
        restoreMicUi();
        return;
      }
    }

    if (!intent || intent.action === 'none') {
      toast(`"${transcript}" — 未执行 (${(intent && intent.reason) || '无法识别'})`);
      restoreMicUi();
      return;
    }

    // (4) 指代解析（click_target）
    if (intent.action === 'click_target') {
      const tgt = resolveDeicticTarget();
      if (!tgt) {
        toast('没有可操作的目标，请用手势或注视指向');
        restoreMicUi();
        return;
      }
      intent.target = tgt;
    }

    // (5) 危险动作确认门
    const meta = registry.getMeta(intent.action) || {};
    if (meta.confirmable) {
      const undo = contextManager.buildUndo(intent);
      setPendingConfirm({ intent, undo, label: meta.description || intent.action });
      tts.speak('confirm', '请确认');
      toast(`确认要「${meta.description || intent.action}」吗？说"是 / 确认"`);
      return;
    }

    // (6) 执行
    const undo = contextManager.buildUndo(intent);
    return await runIntent(intent, undo, transcript, confidence);
  }

  /** 统一执行路径：处理来自其他模态（手势/眼动）的命令，与语音走同一套 runIntent */
  async function handleExternalCommand(ev) {
    if (!ev || !ev.action) return;

    const intent = {
      action: ev.action,
      params: ev.params || {},
      source: ev.source,           // 'gesture' | 'gaze' | 'face' — 保留原始来源供仲裁/记录
      target: ev.target || null,
    };

    // 指代解析：外部模态发 click_target 时可能没带目标，从共享上下文取
    if (intent.action === 'click_target' && !intent.target) {
      intent.target = resolveDeicticTarget();
    }

    const label = ev.raw?.gesture || ev.action;
    const undo = contextManager.buildUndo(intent);
    console.log('[VoiceExt] 外部命令 → 统一执行:', ev.source, intent.action, label);
    return await runIntent(intent, undo, label, ev.confidence || 0.9);
  }

  /** 执行一条 intent：仲裁 → pushUndo → execute → record → publish → 反馈 */
  async function runIntent(intent, undo, transcript, confidence) {
    // 多模态仲裁：被其他模态抢先/去重则跳过
    // intent.source 可能是 'local'/'llm'/'context'(→映射为voice) 或 'gesture'/'gaze'/'face'(→保留)
    if (fusion) {
      const modalitySource = (intent.source === 'gesture' || intent.source === 'gaze' || intent.source === 'face')
        ? intent.source : 'voice';
      const verdict = fusion.arbitrate({ action: intent.action, source: modalitySource, timestamp: Date.now() });
      if (!verdict.execute) {
        console.log('[VoiceExt] 仲裁跳过:', intent.action, verdict.reason, '←', verdict.winner);
        restoreMicUi();
        return;
      }
    }

    ui.setMicState('processing');
    try {
      if (undo) contextManager.pushUndo(undo.undoFn, undo.label);
      const info = await executor.execute(intent, { transcript, confidence, source: intent.source });
      if (!info.ok && undo) contextManager.popUndo();  // 执行失败丢弃撤销项

      contextManager.record(intent, info, { transcript });
      publishToFusion(intent, info, { transcript, confidence });
      notifyExternal(intent, info, { transcript, confidence });
      feedback(intent, info, transcript);
    } catch (err) {
      if (undo) contextManager.popUndo();
      tts.playChime('error');
      ui.setMicState('error');
      errorToast(err.message);
      setTimeout(restoreMicUi, 2000);
      return;
    }

    restoreMicUi();
  }

  // ---- 确认态管理 ----

  function setPendingConfirm(pc) {
    pendingConfirm = pc;
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      if (pendingConfirm) { pendingConfirm = null; toast('确认超时，已取消'); restoreMicUi(); }
    }, CONFIRM_TIMEOUT);
  }
  function clearPendingConfirm() {
    pendingConfirm = null;
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  }

  // ---- 反馈（TTS + Toast）----

  const ACTION_LABELS = {
    scroll_up: '向上滚动', scroll_down: '向下滚动',
    scroll_to_top: '回到顶部', scroll_to_bottom: '滚动到底部',
    refresh: '刷新页面', go_back: '后退', go_forward: '前进',
    zoom_in: '放大', zoom_out: '缩小', zoom_reset: '恢复缩放',
    tab_new: '新标签页',
    stop_listening: '已停止监听', stop_reading: '已停止朗读',
    undo: '撤销',
  };
  const SOURCE_TAG = { local: '⚡本地', llm: '☁AI', context: '↻上下文', gesture: '✋手势', gaze: '👁注视' };

  function feedback(intent, info, transcript) {
    const action = intent.action;
    // TTS 简短反馈（朗读/停止朗读自身就有声音，不重复播报）
    if (action !== 'none' && action !== 'read_page' && action !== 'stop_reading') {
      tts.speak(action);
    }

    const tag = SOURCE_TAG[intent.source] ? ` <small style="opacity:.6">${SOURCE_TAG[intent.source]}</small>` : '';

    if (action === 'comment') {
      if (info.ok) toast(`"${transcript}" → <span class="toast-action">评论: ${info.text}</span><br><small>${info.reason}</small>`);
      else errorToast(`评论失败: ${info.reason || '未知'}`);
    } else if (action === 'like') {
      toast(info.ok ? `"${transcript}" → <span class="toast-action">点赞</span>` : `"${transcript}" → 未找到点赞按钮`);
    } else if (action === 'find') {
      toast(info.ok ? `<span class="toast-action">${info.reason}</span>${tag}` : `未找到`);
    } else if (action === 'read_page') {
      if (info.ok) toast(`"${transcript}" → <span class="toast-action">开始朗读</span>`); else errorToast(info.reason);
    } else if (action === 'click_target') {
      toast(info.ok ? `<span class="toast-action">已点击目标</span>${tag}` : `${info.reason}`);
    } else {
      toast(`"${transcript}" → <span class="toast-action">${ACTION_LABELS[action] || action}</span>${tag}`);
    }
  }

  // ---- 指代目标解析（多模态融合）----

  /** 从 MMFusion 共享上下文取「手势指向 / 眼动注视」目标，验证可解析为活元素 */
  function resolveDeicticTarget() {
    if (!fusion) return null;
    const c = fusion.getContext();
    const t = c.pointerTarget || c.gazeTarget;   // 手势选择优先于眼动注视
    if (!t) return null;
    let el = null;
    if (t.selector) { try { el = document.querySelector(t.selector); } catch (_) {} }
    if (!el && t.point) el = document.elementFromPoint(t.point.x, t.point.y);
    if (!el) return null;
    return Object.assign({}, t, { el });   // 同 world 直接带活 el
  }

  // ---- 对外发布 ----

  /** 发布到多模态融合总线（跨模态共享） */
  function publishToFusion(intent, info, context) {
    if (!fusion) return;
    const { action, source, target, ...params } = intent;
    fusion.publish({
      source: 'voice',
      type: 'command',
      action,
      params,
      target: target || null,
      confidence: context.confidence || 0.95,
      raw: { transcript: context.transcript, ok: !!(info && info.ok), executedFor: source || 'voice' },
      _live: true,
    });
  }

  /** 通知外部监听器（向后兼容的 onEvent API） */
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

  async function startListening() {
    if (!apiKey) {
      toast('未设置 API Key：本地命令和融合测试可用，复杂语义会提示设置');
    }
    if (!recognizer.init()) { errorToast('浏览器不支持语音识别'); return; }

    // 标签页互斥锁
    _acquiring = true;
    _startingAborted = false;
    _channel?.postMessage({ type: 'activate', tabId: TAB_ID });

    const acquired = await acquireLock();
    _acquiring = false;

    if (!acquired || _startingAborted) {
      _startingAborted = false;
      if (!acquired) errorToast('另一个标签页正在使用声控助手，请先在那里关闭');
      return;
    }

    if (wakeEnabled) {
      setMode('passive');
      toast('待机中，说"小助手"唤醒...');
    } else {
      setMode('active');
      toast('正在监听...');
    }
    const started = recognizer.start();
    if (!started) {
      setMode('idle');
      await releaseLock();
    }
  }

  async function stopListening() {
    if (activeTimer) clearTimeout(activeTimer);
    clearPendingConfirm();
    setMode('idle');
    recognizer.stop();
    await releaseLock();
    toast('语音控制已停止');
  }

  async function toggleMic() {
    if (mode !== 'idle') { await stopListening(); }
    else { await startListening(); }
  }

  // ============================================================
  //  事件绑定
  // ============================================================

  function bindEvents() {
    const sub = (e, h) => { unsubscribers.push(bus.on(e, h)); };

    // BroadcastChannel：跨标签即时互斥
    if (_channel) _channel.onmessage = _handleChannelMessage;

    // 多模态融合：订阅其他模态事件，命令类路由到统一执行路径
    if (fusion) {
      const unsub = fusion.subscribe((ev) => {
        if (!ev || ev.source === 'voice') return;
        if (ev.type === 'command' && ev.action) {
          handleExternalCommand(ev);
        } else {
          console.log('[VoiceExt] 收到', ev.source, '事件:', ev.type, ev.action || '');
        }
      });
      unsubscribers.push(unsub);
    }

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
      console.warn('[VoiceExt] speech:error', d);
      if (d.silent) return;
      if (shouldThrottleSpeechError(d)) return;
      if (d.retrying) {
        toast(getSpeechErrorMessage(d), d.error === 'network' ? 'error' : undefined);
        return;
      }
      if (d.fatal) {
        setMode('idle');
        releaseLock();
        errorToast(d.message || `识别错误: ${d.error}`);
        return;
      }
      ui.setMicState('error');
      errorToast(`识别错误: ${d.error}`);
      setTimeout(() => {
        if (mode !== 'idle') setMode(mode);
        else ui.setMicState('idle');
      }, 2000);
    });

    // 停止（fire-and-forget）
    sub('voice:stop_requested', () => { stopListening(); });

    // TTS 期间暂停/恢复识别
    sub('voice:pause_recognition', () => recognizer.pause());
    sub('voice:resume_recognition', () => { if (mode !== 'idle') recognizer.resume(); });

    // 日志
    sub('action:executed', (d) => {
      console.log('[VoiceExt]', d.action, d.result?.ok ? '✓' : '✗', d.result?.reason || '');
    });

    // 页面切后台时暂停识别，回来恢复
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && mode !== 'idle') {
        recognizer.pause();
      } else if (!document.hidden && mode !== 'idle') {
        recognizer.resume();
        if (mode === 'active') resetActiveTimer();
      }
    });

    // 标签页关闭前释放锁
    window.addEventListener('beforeunload', () => {
      releaseLock();
    });

    // 监听锁变化：其他标签页抢到锁时本页自动关掉（BroadcastChannel 的补充备用）
    try {
      chrome.storage.session.onChanged.addListener(async (changes) => {
        if (changes.voice_active_lock && mode !== 'idle') {
          const newHolder = changes.voice_active_lock.newValue;
          if (newHolder && newHolder !== TAB_ID) {
            console.log('[VoiceExt] 锁被标签页 ' + newHolder + ' 抢占，自动关闭');
            if (lockInterval) { clearInterval(lockInterval); lockInterval = null; }
            if (activeTimer) clearTimeout(activeTimer);
            setMode('idle');
            recognizer.stop();
            toast('已在其他标签页启动声控助手');
          }
        }
      });
    } catch (_) { /* storage.session 不可用 */ }
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
      console.log('[VoiceExt] Controller gesvoice-v0.3 initialized —',
        registry.list().length, 'actions, wake word:', WAKE_WORD,
        '| 本地匹配 + LLM 兜底 + 融合:', fusion ? 'on' : 'off');
    },

    async dispose() {
      await stopListening();
      tts.stop();
      recognizer.dispose();
      for (const u of unsubscribers) u();
      unsubscribers = [];
      externalListeners.length = 0;
      contextManager.clear();
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

    async processTextCommand(text, confidence = 0.99) {
      const transcript = String(text || '').trim();
      if (!transcript) return { ok: false, reason: 'empty command' };
      await processCommand(transcript, confidence);
      return { ok: true, transcript };
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
        fusion: !!fusion,
        version: 'gesvoice-v0.3',
      };
    },
  };

  exports.controller = controller;

  // 自动启动
  controller.init().then(() => {
    recognizer.onShouldPause = () => tts.isSpeaking();
    console.log('[VoiceExt] GesVoice v0.2 已就绪 — 可用测试面板提交文本语音');
  });

})(window.VoiceExt);
