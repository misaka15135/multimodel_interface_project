(function () {
  'use strict';

  // ============================================================
  //  DeepSeek LLM API（来自 src/js/llm.js）
  // ============================================================
  const DEEPSEEK_BASE = 'https://api.deepseek.com/v1/chat/completions';
  const MODEL = 'deepseek-chat';

  const SYSTEM_PROMPT = `你是一个浏览器操作助手。根据用户的语音指令，推断用户想要执行什么网页操作。

严格返回以下 JSON 格式之一，不要返回其他内容：
{"action":"scroll_up","amount":300}
{"action":"scroll_down","amount":300}
{"action":"scroll_to_top"}
{"action":"scroll_to_bottom"}
{"action":"refresh"}
{"action":"go_back"}
{"action":"go_forward"}
{"action":"like"}
{"action":"comment","text":"提取出的评论正文"}
{"action":"stop_listening"}
{"action":"none","reason":"无法识别的原因"}

action 说明：
- scroll_up / scroll_down: amount 为滚动像素数，默认 300
- scroll_to_top / scroll_to_bottom: 滚动到页面顶部/底部
- refresh: 刷新当前页面
- go_back / go_forward: 浏览器前进/后退
- like: 用户想点赞，需找到并点击页面中的点赞按钮

---
★ 评论功能 ★
- comment: 用户想对当前页面/帖子发表评论，text 是从用户语音中提取出的评论正文。
  例如用户说"评论太棒了" → {"action":"comment","text":"太棒了"}
  用户说"评论说这个帖子写得真好" → {"action":"comment","text":"这个帖子写得真好"}
  注意 text 只包含评论内容本身，去掉"评论""说""我想说"等引导词。

---
★ 停止监听 ★
- stop_listening: 用户想结束语音控制、停止监听。例如：
  "停止监听" "关闭语音" "别听了" "不用了" "结束" "退下" "休息吧"
  这些都不是 none，必须返回 {"action":"stop_listening"}

---
- none: 无法识别用户意图或不需要操作，需附带 reason`;

  async function callLLM(userText, apiKey) {
    if (!apiKey) throw new Error('未设置 API Key');
    const res = await fetch(DEEPSEEK_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText }
        ],
        temperature: 0.1,
        max_tokens: 200
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API 错误 (${res.status}): ${err}`);
    }
    const data = await res.json();
    const raw = data.choices[0].message.content.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM 返回非 JSON: ' + raw);
    return JSON.parse(jsonMatch[0]);
  }

  // ============================================================
  //  操作执行（来自 src/js/voice.js）
  // ============================================================
  async function executeAction(intent, transcript) {
    const { action, amount, text } = intent;
    let commentResult = null;

    switch (action) {
      case 'scroll_up':
        window.scrollBy({ top: -(amount || 300), behavior: 'smooth' });
        break;
      case 'scroll_down':
        window.scrollBy({ top: amount || 300, behavior: 'smooth' });
        break;
      case 'scroll_to_top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'scroll_to_bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        break;
      case 'refresh':
        location.reload();
        break;
      case 'go_back':
        history.back();
        break;
      case 'go_forward':
        history.forward();
        break;
      case 'like':
        triggerLike();
        break;
      case 'comment':
        commentResult = await triggerComment(text || '');
        break;
      case 'stop_listening':
        isListening = false;
        setMicState('idle');
        if (recognizer) {
          try { recognizer.stop(); } catch (_) { /* ignore */ }
        }
        break;
    }

    return { action, text, commentResult };
  }

  function triggerLike() {
    const selectors = [
      '[aria-label*="赞"]', '[aria-label*="like"]', '[aria-label*="Like"]',
      '[data-testid*="like"]', '[data-testid*="Like"]',
      'button[class*="like"]', 'button[class*="Like"]',
      '.like-btn', '.Like', '[title*="赞"]',
      'svg[class*="like"]', 'svg[aria-label*="like"]',
      '[class*="like"]', '[class*="zan"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return true; }
    }
    const buttons = document.querySelectorAll('button, [role="button"], span, div');
    for (const btn of buttons) {
      const t = btn.textContent?.trim() || '';
      if (/^赞$|^点赞$|^like$/i.test(t) && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  // 构造完整键盘事件（包含 code 属性，B站等框架依赖此属性）
  function makeEnterEvent(type) {
    return new KeyboardEvent(type, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    });
  }

  // B站 API 直接发评论（绕过 DOM 模拟，可靠性高得多）
  async function postBilibiliComment(text) {
    const csrfMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    if (!csrfMatch) return { ok: false, reason: '未登录B站，无CSRF token' };
    const csrf = csrfMatch[1];

    // 暴力提取页面 ID：扫描所有可能的位置
    let oid = null, type = 1;
    const s = window.__INITIAL_STATE__ || {};

    // 1. 常用路径
    const tryGet = (obj, ...keys) => {
      for (const k of keys) { obj = obj?.[k]; if (obj == null) return null; }
      return obj;
    };
    const idCandidates = [
      () => tryGet(s, 'aid'),
      () => tryGet(s, 'videoData', 'aid'),
      () => tryGet(s, 'videoInfo', 'aid'),
      () => tryGet(s, 'videoData', 'bvid'),
      () => tryGet(s, 'bvid'),
      () => tryGet(s, 'readInfo', 'id'),
      () => tryGet(s, 'dynamicDetail', 'dynamicId'),
      // 深层扫描：遍历 __INITIAL_STATE__ 顶层所有key找aid/bvid
      () => {
        for (const key of Object.keys(s)) {
          const v = s[key];
          if (!v || typeof v !== 'object') continue;
          if (v.aid) return v.aid;
          if (v.bvid) return v.bvid;
          if (v.id && (key.includes('video') || key.includes('read') || key.includes('dynamic'))) return v.id;
        }
        return null;
      },
      // URL: /video/BVxxx 或 /video/av123 或 /bangumi/play/ep123 或 /read/cv123
      () => {
        let m = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
        if (m) return m[1]; // BV号
        m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/);
        if (m) { type = 4; return parseInt(m[1]); } // 番剧 ep
        m = location.pathname.match(/\/(?:av|cv)(\d+)/i);
        if (m) { type = location.pathname.includes('cv') ? 12 : 1; return parseInt(m[1]); }
        return null;
      },
      // URL查询参数
      () => new URLSearchParams(location.search).get('aid'),
      // 页面中嵌入的 aid data 属性
      () => {
        const el = document.querySelector('[data-aid]');
        return el ? el.dataset.aid : null;
      },
    ];

    for (const fn of idCandidates) {
      try {
        const result = fn();
        if (result) { oid = result; break; }
      } catch (_) {}
    }

    // 如果oid是数字且来自专栏路径，设type=12
    if (typeof oid === 'number') {
      // 已经是数字aid
    }

    console.log('[声控助手] B站 __INITIAL_STATE__ keys:', Object.keys(s));
    console.log('[声控助手] B站API评论 oid:', oid, 'type:', type);

    if (!oid) return { ok: false, reason: '无法获取页面ID，请确保在视频/文章/动态页' };

    const body = new URLSearchParams();
    body.append('oid', oid);
    body.append('type', type);
    body.append('message', text);
    body.append('plat', '1');
    body.append('csrf', csrf);
    body.append('root', '0');
    body.append('parent', '0');

    const res = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await res.json();
    console.log('[声控助手] B站API响应:', data);

    if (data.code === 0) return { ok: true, reason: '评论发送成功' };
    // 常见错误码
    const errMap = {
      '-101': '未登录', '-102': '账号被封', '-105': '需要验证码',
      '-400': '请求错误', '-403': '权限不足', '-404': '评论不存在',
      '-509': '评论过于频繁',
    };
    return { ok: false, reason: `API: ${errMap[String(data.code)] || data.message || data.code}` };
  }

  async function triggerComment(commentText) {
    if (!commentText) return { ok: false, reason: '评论内容为空' };

    // B站优先走 API，拿不到ID则回退到DOM模拟
    if (location.hostname.includes('bilibili.com')) {
      const apiResult = await postBilibiliComment(commentText);
      if (apiResult.ok) return apiResult;
      // API失败（如不在视频页或未登录），回退DOM模拟
      console.log('[声控助手] B站API失败，回退DOM模拟:', apiResult.reason);
    }

    const inputSelectors = [
      '#comment-input',
      '[id*="comment"]',
      '[class*="comment"] input',
      'input[placeholder*="评论"]', 'input[placeholder*="comment"]',
      'input[placeholder*="说点"]', 'textarea[placeholder*="评论"]',
      'textarea[placeholder*="comment"]',
      '[contenteditable="true"]',
    ];
    let inputEl = null;
    let matchedBy = '';
    for (const sel of inputSelectors) {
      inputEl = document.querySelector(sel);
      if (inputEl) { matchedBy = sel; break; }
    }
    if (!inputEl) {
      return { ok: false, reason: '未找到评论输入框，请先手动点开评论区域' };
    }
    console.log('[声控助手] 评论输入框:', inputEl.tagName, inputEl.className, 'matched:', matchedBy);

    // 先聚焦，等框架初始化输入框的事件监听
    inputEl.focus();
    inputEl.click(); // B站可能需要点击激活编辑器
    await new Promise(r => setTimeout(r, 150));

    if (inputEl.isContentEditable) {
      // 清空旧内容
      inputEl.textContent = '';
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));

      // 用 execCommand 写入文本（触发 Vue/React 数据绑定）
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(inputEl);
        range.collapse(false);
        sel.addRange(range);
      }
      try { document.execCommand('insertText', false, commentText); } catch (_) {
        // execCommand 不可用时回退到 textContent
        inputEl.textContent = commentText;
      }
      inputEl.dispatchEvent(new Event('beforeinput', { bubbles: true, composed: true }));
      inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      inputEl.dispatchEvent(new CompositionEvent('compositionend', {
        data: commentText, bubbles: true, composed: true
      }));
    } else {
      const proto = Object.getPrototypeOf(inputEl);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        try { descriptor.set.call(inputEl, commentText); }
        catch (_) { inputEl.value = commentText; }
      } else {
        inputEl.value = commentText;
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    // 等待前端框架创建/更新按钮（B站等需要较长时间激活编辑器后才渲染按钮）
    await new Promise(r => setTimeout(r, 800));

    // 查找提交按钮（多策略）
    let submitBtn = null;

    // 策略1: 在输入框的祖先容器内查找
    const container = inputEl.closest('form, [class*="comment"], [class*="reply"], [class*="send"], [class*="submit-area"], [class*="editor"]');
    if (container) {
      // 先按 class 名精确匹配
      const clsPatterns = [
        'button[class*="submit"]', 'button[class*="send"]', 'button[class*="publish"]',
        'button[class*="release"]', 'button[class*="post"]', 'button[class*="confirm"]',
        'button[class*="primary"]', 'button[class*="btn-primary"]', 'button[class*="active"]',
        '[class*="submit"] button', '[class*="send"] button', '[class*="publish"] button',
        'span[class*="submit"]', 'span[class*="send"]', 'span[class*="publish"]', 'span[class*="active"]',
        'div[class*="submit"]', 'div[class*="send"]',
      ];
      for (const pat of clsPatterns) {
        const el = container.querySelector(pat);
        if (el && el.offsetParent !== null) { submitBtn = el; break; }
      }
      // 再遍历所有按钮匹配文字
      if (!submitBtn) {
        const btns = container.querySelectorAll('button, [role="button"], span[role="button"]');
        for (const btn of btns) {
          const t = (btn.textContent || '').trim();
          if (/^(发送|评论|提交|发布|发表|回复|确定)$|^submit$|^post$/i.test(t) && btn.offsetParent !== null) {
            submitBtn = btn;
            break;
          }
        }
      }
      // 再按 aria-label
      if (!submitBtn) {
        submitBtn = container.querySelector('[aria-label*="发送"], [aria-label*="提交"], [aria-label*="发布"], [aria-label*="submit"], [aria-label*="send"]');
      }
    }

    // 策略2: 从输入框向外逐层查找按钮（应对深层嵌套DOM）
    if (!submitBtn) {
      let node = inputEl.parentElement;
      for (let i = 0; i < 12 && node && !submitBtn; i++) {
        const btn = node.querySelector('button, span[role="button"], [class*="submit"], [class*="send"], [class*="publish"], [class*="active"]');
        if (btn && btn.offsetParent !== null) submitBtn = btn;
        node = node.parentElement;
      }
    }

    // 策略3: 全局查找 — 扩大到所有可见元素（B站按钮可能是 span/div）
    if (!submitBtn) {
      submitBtn = document.querySelector('button[type="submit"]');
    }
    if (!submitBtn) {
      // 按文字匹配，不限标签类型
      const candidates = document.querySelectorAll('button, [role="button"], span, div, a');
      for (const el of candidates) {
        const t = (el.textContent || '').trim().replace(/\s+/g, '');
        if (/^(发送|评论|提交|发布|发表|回复)$|^submit$|^post$/i.test(t) && el.offsetParent !== null) {
          submitBtn = el;
          break;
        }
      }
    }
    // 策略4: 全局按 class 匹配（兜底）
    if (!submitBtn) {
      const globalPatterns = [
        '[class*="submit-btn"]', '[class*="send-btn"]', '[class*="publish-btn"]',
        '[class*="comment-submit"]', '[class*="reply-submit"]',
        'button[class*="active"]', 'span[class*="active"]', 'div[class*="active"]',
        '[class*="btn-send"]', '[class*="btn-submit"]', '[class*="btn-publish"]',
      ];
      for (const pat of globalPatterns) {
        const el = document.querySelector(pat);
        if (el && el.offsetParent !== null) { submitBtn = el; break; }
      }
    }

    console.log('[声控助手] 提交按钮:', submitBtn?.tagName, submitBtn?.className, 'disabled:', submitBtn?.disabled);

    if (submitBtn && !submitBtn.disabled) {
      submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
      submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
      submitBtn.click();
      return { ok: true, reason: '已提交' };
    } else if (submitBtn && submitBtn.disabled) {
      return { ok: false, reason: '提交按钮禁用中，可能需输入更多内容或通过验证' };
    } else {
      // 兜底: 完整 Enter 键序列（含 code/composed 属性）
      console.log('[声控助手] 未找到提交按钮，尝试 Enter 键');
      inputEl.dispatchEvent(makeEnterEvent('keydown'));
      inputEl.dispatchEvent(makeEnterEvent('keypress'));
      inputEl.dispatchEvent(makeEnterEvent('keyup'));
      return { ok: true, reason: '已尝试Enter键提交' };
    }
  }

  // ============================================================
  //  UI 注入
  // ============================================================
  const container = document.createElement('div');
  container.id = 'voice-ext-container';
  container.innerHTML = `
    <div id="voice-ext-toast"></div>
    <div id="voice-ext-settings">
      <label>DeepSeek API Key</label>
      <input id="voice-ext-apikey" type="password" placeholder="sk-..." autocomplete="off">
      <div class="btn-row">
        <button class="btn-cancel" id="voice-ext-cancel">取消</button>
        <button class="btn-save" id="voice-ext-save">保存</button>
      </div>
    </div>
    <button id="voice-ext-mic-btn" class="idle" title="开启语音控制">语音<br>控制</button>
    <button id="voice-ext-gear-btn" title="设置">⚙</button>
  `;
  document.body.appendChild(container);

  // ============================================================
  //  DOM 引用
  // ============================================================
  const micBtn = document.getElementById('voice-ext-mic-btn');
  const gearBtn = document.getElementById('voice-ext-gear-btn');
  const settings = document.getElementById('voice-ext-settings');
  const apiKeyInput = document.getElementById('voice-ext-apikey');
  const toast = document.getElementById('voice-ext-toast');
  const saveBtn = document.getElementById('voice-ext-save');
  const cancelBtn = document.getElementById('voice-ext-cancel');

  // ============================================================
  //  状态
  // ============================================================
  let apiKey = '';
  let recognizer = null;
  let isListening = false;
  let toastTimer = null;

  // ============================================================
  //  Toast
  // ============================================================
  function showToast(msg, type) {
    if (toastTimer) clearTimeout(toastTimer);
    toast.className = type || '';
    toast.innerHTML = msg;
    requestAnimationFrame(() => toast.classList.add('show'));
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // ============================================================
  //  按钮状态
  // ============================================================
  function setMicState(state) {
    micBtn.className = state;
    const labels = {
      idle: '语音<br>控制',
      listening: '监听<br>中',
      processing: '处理<br>中',
      error: '错误'
    };
    micBtn.innerHTML = labels[state] || labels.idle;
  }

  // ============================================================
  //  API Key 持久化
  // ============================================================
  async function loadApiKey() {
    try {
      const result = await chrome.storage.local.get('voice_ext_apikey');
      if (result.voice_ext_apikey) {
        apiKey = result.voice_ext_apikey;
        apiKeyInput.value = apiKey;
      }
    } catch (_) { /* ignore */ }
  }

  async function saveApiKey() {
    const key = apiKeyInput.value.trim();
    if (!key) return;
    apiKey = key;
    try {
      await chrome.storage.local.set({ voice_ext_apikey: key });
    } catch (_) { /* ignore */ }
    settings.classList.remove('show');
    showToast('API Key 已保存', '');
  }

  // ============================================================
  //  Web Speech API
  // ============================================================
  function setupSpeech() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast('<span class="toast-error">浏览器不支持语音识别</span>');
      return null;
    }
    const rec = new SpeechRecognition();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.continuous = false;

    rec.onresult = async (evt) => {
      const result = evt.results[evt.results.length - 1][0];
      const transcript = result.transcript.trim();
      if (!transcript) return;

      showToast(`识别: "${transcript}"`);

      if (!apiKey) {
        showToast('<span class="toast-error">请先设置 API Key</span>', 'error');
        settings.classList.add('show');
        setMicState('idle');
        isListening = false;
        return;
      }

      setMicState('processing');
      try {
        const intent = await callLLM(transcript, apiKey);
        const info = await executeAction(intent, transcript);

        if (intent.action === 'none') {
          showToast(`"${transcript}" — 未执行 (${intent.reason || '无法识别'})`);
        } else if (intent.action === 'comment') {
          const cr = info.commentResult;
          if (cr && cr.ok) {
            showToast(`"${transcript}" → <span class="toast-action">评论: ${info.text}</span><br><small>${cr.reason}</small>`);
          } else {
            showToast(`"${transcript}" → <span class="toast-error">评论失败: ${cr ? cr.reason : '未知'}</span>`, 'error');
          }
        } else if (intent.action === 'like') {
          showToast(`"${transcript}" → <span class="toast-action">点赞</span>`);
        } else {
          const labels = {
            scroll_up: '向上滚动', scroll_down: '向下滚动',
            scroll_to_top: '回到顶部', scroll_to_bottom: '滚动到底部',
            refresh: '刷新页面', go_back: '后退', go_forward: '前进',
            stop_listening: '已停止监听'
          };
          showToast(`"${transcript}" → <span class="toast-action">${labels[intent.action] || intent.action}</span>`);
        }
      } catch (err) {
        setMicState('error');
        showToast(`<span class="toast-error">${err.message}</span>`, 'error');
        setTimeout(() => {
          if (isListening) setMicState('listening');
          else setMicState('idle');
        }, 2000);
        restartIfActive();
        return;
      }

      restartIfActive();
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') {
        // 静默处理，重新开始
        restartIfActive();
        return;
      }
      setMicState('error');
      showToast(`<span class="toast-error">识别错误: ${e.error}</span>`, 'error');
      setTimeout(() => {
        if (isListening) setMicState('listening');
        else setMicState('idle');
      }, 2000);
      restartIfActive();
    };

    rec.onend = () => {
      // 如果仍在活跃状态，自动重新开始
      if (isListening) {
        try { rec.start(); } catch (_) { /* already started */ }
      } else {
        setMicState('idle');
      }
    };

    return rec;
  }

  function restartIfActive() {
    if (!isListening || !recognizer) return;
    setMicState('listening');
    setTimeout(() => {
      if (isListening) {
        try { recognizer.start(); } catch (_) { /* ignore */ }
      }
    }, 300);
  }

  // ============================================================
  //  麦克风切换
  // ============================================================
  function toggleMic() {
    if (isListening) {
      // 停止
      isListening = false;
      setMicState('idle');
      if (recognizer) {
        try { recognizer.stop(); } catch (_) { /* ignore */ }
      }
      showToast('语音控制已停止');
    } else {
      // 检查 API Key
      if (!apiKey) {
        settings.classList.add('show');
        showToast('<span class="toast-error">请先设置 API Key</span>', 'error');
        return;
      }
      // 初始化 SpeechRecognition（延迟初始化，需用户手势后）
      if (!recognizer) {
        recognizer = setupSpeech();
        if (!recognizer) return;
      }
      isListening = true;
      setMicState('listening');
      try { recognizer.start(); } catch (_) { /* ignore */ }
      showToast('正在监听...');
    }
  }

  // ============================================================
  //  事件绑定
  // ============================================================
  micBtn.addEventListener('click', toggleMic);

  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settings.classList.toggle('show');
  });

  saveBtn.addEventListener('click', saveApiKey);

  cancelBtn.addEventListener('click', () => {
    settings.classList.remove('show');
    apiKeyInput.value = apiKey; // 恢复原值
  });

  // 点击外部关闭设置面板
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      settings.classList.remove('show');
    }
  });

  // 回车保存
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveApiKey();
  });

  // ============================================================
  //  启动
  // ============================================================
  loadApiKey();
  console.log('[声控助手] 已注入 — 点击右下角按钮开始语音控制');
})();
