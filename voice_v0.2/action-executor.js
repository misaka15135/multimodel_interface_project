'use strict';

// ============================================================
//  ActionExecutor — 动作执行引擎
//  注册所有内置动作到 actionRegistry，提供 execute() 方法
//  执行结果通过 eventBus 发出 action:executed 事件
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  const bus = exports.eventBus;
  const registry = exports.actionRegistry;

  // ============================================================
  //  辅助工具
  // ============================================================

  /** 构造完整键盘事件（包含 code 属性，B站等框架依赖） */
  function makeEnterEvent(type) {
    return new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
    });
  }

  /** 查找页面中的点赞按钮并点击 */
  function findAndClickLike() {
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
    // 兜底：文本匹配
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

  // ============================================================
  //  B站评论专用（API + DOM 双路由）
  // ============================================================

  async function postBilibiliComment(text) {
    const csrfMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    if (!csrfMatch) return { ok: false, reason: '未登录B站，无CSRF token' };

    const csrf = csrfMatch[1];
    let oid = null, type = 1;
    const s = window.__INITIAL_STATE__ || {};

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
      () => {
        let m = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
        if (m) return m[1];
        m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/);
        if (m) { type = 4; return parseInt(m[1]); }
        m = location.pathname.match(/\/(?:av|cv)(\d+)/i);
        if (m) { type = location.pathname.includes('cv') ? 12 : 1; return parseInt(m[1]); }
        return null;
      },
      () => new URLSearchParams(location.search).get('aid'),
      () => { const el = document.querySelector('[data-aid]'); return el ? el.dataset.aid : null; },
    ];

    for (const fn of idCandidates) {
      try { const r = fn(); if (r) { oid = r; break; } } catch (_) {}
    }

    console.log('[VoiceExt] B站 __INITIAL_STATE__ keys:', Object.keys(s));
    console.log('[VoiceExt] B站API评论 oid:', oid, 'type:', type);

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
      body: body.toString(),
    });
    const data = await res.json();
    console.log('[VoiceExt] B站API响应:', data);

    if (data.code === 0) return { ok: true, reason: '评论发送成功' };

    const errMap = {
      '-101': '未登录', '-102': '账号被封', '-105': '需要验证码',
      '-400': '请求错误', '-403': '权限不足', '-404': '评论不存在',
      '-509': '评论过于频繁',
    };
    return { ok: false, reason: `API: ${errMap[String(data.code)] || data.message || data.code}` };
  }

  async function triggerCommentDom(commentText) {
    if (!commentText) return { ok: false, reason: '评论内容为空' };

    const inputSelectors = [
      '#comment-input', '[id*="comment"]',
      '[class*="comment"] input', 'input[placeholder*="评论"]',
      'input[placeholder*="comment"]', 'input[placeholder*="说点"]',
      'textarea[placeholder*="评论"]', 'textarea[placeholder*="comment"]',
      '[contenteditable="true"]',
    ];
    let inputEl = null;
    for (const sel of inputSelectors) {
      inputEl = document.querySelector(sel);
      if (inputEl) break;
    }
    if (!inputEl) return { ok: false, reason: '未找到评论输入框，请先手动点开评论区域' };

    console.log('[VoiceExt] 评论输入框:', inputEl.tagName, inputEl.className);

    inputEl.focus();
    inputEl.click();
    await new Promise(r => setTimeout(r, 150));

    if (inputEl.isContentEditable) {
      inputEl.textContent = '';
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));

      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(inputEl);
        range.collapse(false);
        sel.addRange(range);
      }
      try { document.execCommand('insertText', false, commentText); } catch (_) {
        inputEl.textContent = commentText;
      }
      ['beforeinput', 'input', 'change'].forEach(name =>
        inputEl.dispatchEvent(new Event(name, { bubbles: true, composed: true })));
      inputEl.dispatchEvent(new CompositionEvent('compositionend', {
        data: commentText, bubbles: true, composed: true,
      }));
    } else {
      const proto = Object.getPrototypeOf(inputEl);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        try { descriptor.set.call(inputEl, commentText); } catch (_) { inputEl.value = commentText; }
      } else {
        inputEl.value = commentText;
      }
      ['input', 'change'].forEach(name =>
        inputEl.dispatchEvent(new Event(name, { bubbles: true, composed: true })));
    }

    // 等待前端框架渲染提交按钮
    await new Promise(r => setTimeout(r, 800));

    // 多策略查找提交按钮
    let submitBtn = null;

    const container = inputEl.closest('form, [class*="comment"], [class*="reply"], [class*="send"], [class*="submit-area"], [class*="editor"]');
    if (container) {
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
      if (!submitBtn) {
        const btns = container.querySelectorAll('button, [role="button"], span[role="button"]');
        for (const btn of btns) {
          const t = (btn.textContent || '').trim();
          if (/^(发送|评论|提交|发布|发表|回复|确定)$|^submit$|^post$/i.test(t) && btn.offsetParent !== null) {
            submitBtn = btn; break;
          }
        }
      }
      if (!submitBtn) {
        submitBtn = container.querySelector('[aria-label*="发送"], [aria-label*="提交"], [aria-label*="发布"], [aria-label*="submit"], [aria-label*="send"]');
      }
    }

    if (!submitBtn) {
      let node = inputEl.parentElement;
      for (let i = 0; i < 12 && node && !submitBtn; i++) {
        const btn = node.querySelector('button, span[role="button"], [class*="submit"], [class*="send"], [class*="publish"], [class*="active"]');
        if (btn && btn.offsetParent !== null) submitBtn = btn;
        node = node.parentElement;
      }
    }

    if (!submitBtn) submitBtn = document.querySelector('button[type="submit"]');

    if (!submitBtn) {
      const candidates = document.querySelectorAll('button, [role="button"], span, div, a');
      for (const el of candidates) {
        const t = (el.textContent || '').trim().replace(/\s+/g, '');
        if (/^(发送|评论|提交|发布|发表|回复)$|^submit$|^post$/i.test(t) && el.offsetParent !== null) {
          submitBtn = el; break;
        }
      }
    }

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

    console.log('[VoiceExt] 提交按钮:', submitBtn?.tagName, submitBtn?.className, 'disabled:', submitBtn?.disabled);

    if (submitBtn && !submitBtn.disabled) {
      submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
      submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
      submitBtn.click();
      return { ok: true, reason: '已提交' };
    } else if (submitBtn && submitBtn.disabled) {
      return { ok: false, reason: '提交按钮禁用中，可能需输入更多内容或通过验证' };
    } else {
      console.log('[VoiceExt] 未找到提交按钮，尝试 Enter 键');
      ['keydown', 'keypress', 'keyup'].forEach(type => inputEl.dispatchEvent(makeEnterEvent(type)));
      return { ok: true, reason: '已尝试Enter键提交' };
    }
  }

  // ============================================================
  //  注册所有内置动作
  // ============================================================

  registry.register('scroll_up', async (params) => {
    const amount = params.amount || 300;
    window.scrollBy({ top: -amount, behavior: 'smooth' });
    return { ok: true };
  }, { description: '向上滚动', icon: '⬆', category: 'navigation' });

  registry.register('scroll_down', async (params) => {
    const amount = params.amount || 300;
    window.scrollBy({ top: amount, behavior: 'smooth' });
    return { ok: true };
  }, { description: '向下滚动', icon: '⬇', category: 'navigation' });

  registry.register('scroll_to_top', async () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return { ok: true };
  }, { description: '回到顶部', icon: '⏫', category: 'navigation' });

  registry.register('scroll_to_bottom', async () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    return { ok: true };
  }, { description: '滚动到底部', icon: '⏬', category: 'navigation' });

  registry.register('refresh', async () => {
    location.reload();
    return { ok: true };
  }, { description: '刷新页面', icon: '🔄', category: 'navigation' });

  registry.register('go_back', async () => {
    history.back();
    return { ok: true };
  }, { description: '后退', icon: '⬅', category: 'navigation' });

  registry.register('go_forward', async () => {
    history.forward();
    return { ok: true };
  }, { description: '前进', icon: '➡', category: 'navigation' });

  registry.register('like', async () => {
    const ok = findAndClickLike();
    return { ok, reason: ok ? '' : '未找到点赞按钮' };
  }, { description: '点赞', icon: '👍', category: 'social' });

  registry.register('comment', async (params, context) => {
    const commentText = params.text || '';
    if (!commentText) return { ok: false, reason: '评论内容为空' };

    // B站优先走 API
    if (location.hostname.includes('bilibili.com')) {
      const apiResult = await postBilibiliComment(commentText);
      if (apiResult.ok) return apiResult;
      console.log('[VoiceExt] B站API失败，回退DOM模拟:', apiResult.reason);
    }

    return await triggerCommentDom(commentText);
  }, { description: '发表评论', icon: '💬', category: 'social' });

  registry.register('stop_listening', async () => {
    bus.emit('voice:stop_requested');
    return { ok: true };
  }, { description: '停止监听', icon: '⏹', category: 'system' });

  registry.register('none', async (params) => {
    return { ok: false, reason: params.reason || '无法识别', skipped: true };
  }, { description: '（忽略）', icon: '⊘', category: 'system' });

  // ============================================================
  //  ActionExecutor 类
  // ============================================================

  class ActionExecutor {
    /**
     * 执行一个意图
     * @param {object} intent  — { action, amount?, text?, reason? }
     * @param {object} context — { transcript, confidence } 等元信息
     * @returns {Promise<object>} { action, ok, reason?, text?, result? }
     */
    async execute(intent, context = {}) {
      const { action } = intent;
      const handler = registry.get(action);

      // 发出 pre 事件
      bus.emit('action:will_execute', { action, intent, context });

      let result;
      if (!handler) {
        console.warn('[VoiceExt] 未注册的动作:', action);
        result = { ok: false, reason: `未知动作: ${action}` };
      } else {
        try {
          // 构造 params：把 intent 中除 action 外的字段传入
          const { action: _, ...params } = intent;
          result = await handler(params, context);
          // 默认 ok=true，handler 返回的 ok 值优先覆盖
          result = { ok: true, ...(result || {}) };
        } catch (err) {
          console.error('[VoiceExt] 动作执行异常:', action, err);
          result = { ok: false, reason: err.message };
        }
      }

      // 发出 post 事件（标准多模态格式）
      const event = {
        source: 'voice',
        action,
        params: intent,
        result,
        confidence: context.confidence || 0,
        timestamp: Date.now(),
        raw: context,
      };
      bus.emit('action:executed', event);

      return { action, ...result, text: intent.text };
    }
  }

  exports.actionExecutor = new ActionExecutor();
  console.log('[VoiceExt] ActionExecutor initialized —', registry.list().length, 'actions registered');

})(window.VoiceExt);
