'use strict';

// ============================================================
//  ActionExecutor — 动作执行引擎
//  注册所有内置动作到 actionRegistry，提供 execute() 方法
//  meta：confirmable（危险动作需确认）、reversible（可撤销）
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  const bus = exports.eventBus;
  const registry = exports.actionRegistry;
  const tts = exports.ttsManager;

  // ============================================================
  //  辅助工具
  // ============================================================

  function makeEnterEvent(type) {
    return new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
    });
  }

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

  /** 解析跨模态目标描述 → 活元素：优先活 el，其次 selector，再次坐标 */
  function resolveTargetEl(t) {
    if (!t) return null;
    if (t.el && t.el.nodeType === 1) return t.el;
    if (t.selector) {
      try { const el = document.querySelector(t.selector); if (el) return el; } catch (_) {}
    }
    if (t.point && typeof t.point.x === 'number') {
      const el = document.elementFromPoint(t.point.x, t.point.y);
      if (el) return el;
    }
    return null;
  }

  /** 从元素出发向上找最近的可点击祖先（<a>, <button>, [role=button], [onclick]），限深 5 层 */
  function nearestClickable(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    var node = el;
    for (var d = 0; d < 5 && node && node !== document.body; d++) {
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return node;
      if (node.getAttribute && (node.getAttribute('role') === 'button' || node.getAttribute('onclick'))) return node;
      // 常见点击模式：cursor:pointer 暗示可点击
      try {
        var style = window.getComputedStyle(node);
        if (style && style.cursor === 'pointer') return node;
      } catch (_) {}
      node = node.parentElement;
    }
    return el; // 找不到就返回原始元素
  }

  /** 在元素上模拟一次真实点击：原生 .click() 优先（触发默认行为），dispatchEvent 兜底 */
  function simulateClick(el) {
    try { el.focus && el.focus(); } catch (_) {}
    var x = 0, y = 0;
    try { var r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; } catch (_) {}
    // 原生 click() 能触发链接跳转、表单提交等默认行为，isTrusted 限制对它不生效
    try { el.click(); } catch (_) {}
    // 额外 dispatchEvent：有些框架（React）在根节点委托，需要事件冒泡
    ['mousedown', 'mouseup', 'click'].forEach(function (type) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
      }));
    });
  }

  /** 提取页面主要内容文本（用于朗读） */
  function extractPageText() {
    // 优先取 <article> 或 <main> 内容
    const main = document.querySelector('article, main, [role="main"]');
    const source = main || document.body;

    // 排除脚本、样式、导航等
    const clone = source.cloneNode(true);
    clone.querySelectorAll('script, style, nav, footer, header, noscript, [aria-hidden="true"]')
      .forEach(el => el.remove());

    const text = clone.textContent || '';
    // 压缩空白，限制长度（朗读太长体验差）
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length > 3000 ? cleaned.slice(0, 3000) + '...' : cleaned;
  }

  // ============================================================
  //  B站评论专用
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
      () => tryGet(s, 'aid'), () => tryGet(s, 'videoData', 'aid'),
      () => tryGet(s, 'videoInfo', 'aid'), () => tryGet(s, 'videoData', 'bvid'),
      () => tryGet(s, 'bvid'), () => tryGet(s, 'readInfo', 'id'),
      () => tryGet(s, 'dynamicDetail', 'dynamicId'),
      () => { for (const key of Object.keys(s)) { const v = s[key]; if (!v || typeof v !== 'object') continue; if (v.aid) return v.aid; if (v.bvid) return v.bvid; if (v.id && (key.includes('video') || key.includes('read') || key.includes('dynamic'))) return v.id; } return null; },
      () => { let m = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/); if (m) return m[1]; m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/); if (m) { type = 4; return parseInt(m[1]); } m = location.pathname.match(/\/(?:av|cv)(\d+)/i); if (m) { type = location.pathname.includes('cv') ? 12 : 1; return parseInt(m[1]); } return null; },
      () => new URLSearchParams(location.search).get('aid'),
      () => { const el = document.querySelector('[data-aid]'); return el ? el.dataset.aid : null; },
    ];
    for (const fn of idCandidates) { try { const r = fn(); if (r) { oid = r; break; } } catch (_) {} }

    console.log('[VoiceExt] B站 oid:', oid, 'type:', type);
    if (!oid) return { ok: false, reason: '无法获取页面ID' };

    const body = new URLSearchParams();
    body.append('oid', oid); body.append('type', type); body.append('message', text);
    body.append('plat', '1'); body.append('csrf', csrf); body.append('root', '0'); body.append('parent', '0');
    const res = await fetch('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json();
    if (data.code === 0) return { ok: true, reason: '评论发送成功' };
    const errMap = { '-101': '未登录', '-102': '账号被封', '-105': '需要验证码', '-400': '请求错误', '-403': '权限不足', '-404': '评论不存在', '-509': '评论过于频繁' };
    return { ok: false, reason: `API: ${errMap[String(data.code)] || data.message || data.code}` };
  }

  async function triggerCommentDom(commentText) {
    if (!commentText) return { ok: false, reason: '评论内容为空' };
    const inputSelectors = ['#comment-input', '[id*="comment"]', '[class*="comment"] input', 'input[placeholder*="评论"]', 'input[placeholder*="comment"]', 'input[placeholder*="说点"]', 'textarea[placeholder*="评论"]', 'textarea[placeholder*="comment"]', '[contenteditable="true"]'];
    let inputEl = null;
    for (const sel of inputSelectors) { inputEl = document.querySelector(sel); if (inputEl) break; }
    if (!inputEl) return { ok: false, reason: '未找到评论输入框' };

    inputEl.focus(); inputEl.click();
    await new Promise(r => setTimeout(r, 150));

    if (inputEl.isContentEditable) {
      inputEl.textContent = '';
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); const range = document.createRange(); range.selectNodeContents(inputEl); range.collapse(false); sel.addRange(range); }
      try { document.execCommand('insertText', false, commentText); } catch (_) { inputEl.textContent = commentText; }
      ['beforeinput', 'input', 'change'].forEach(n => inputEl.dispatchEvent(new Event(n, { bubbles: true, composed: true })));
      inputEl.dispatchEvent(new CompositionEvent('compositionend', { data: commentText, bubbles: true, composed: true }));
    } else {
      const proto = Object.getPrototypeOf(inputEl);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (descriptor && descriptor.set) { try { descriptor.set.call(inputEl, commentText); } catch (_) { inputEl.value = commentText; } }
      else { inputEl.value = commentText; }
      ['input', 'change'].forEach(n => inputEl.dispatchEvent(new Event(n, { bubbles: true, composed: true })));
    }

    await new Promise(r => setTimeout(r, 800));

    let submitBtn = null;
    const container = inputEl.closest('form, [class*="comment"], [class*="reply"], [class*="send"], [class*="submit-area"], [class*="editor"]');
    if (container) {
      const clsPatterns = ['button[class*="submit"]', 'button[class*="send"]', 'button[class*="publish"]', 'button[class*="release"]', 'button[class*="post"]', 'button[class*="confirm"]', 'button[class*="primary"]', 'button[class*="btn-primary"]', 'button[class*="active"]', '[class*="submit"] button', '[class*="send"] button', '[class*="publish"] button', 'span[class*="submit"]', 'span[class*="send"]', 'span[class*="publish"]', 'span[class*="active"]', 'div[class*="submit"]', 'div[class*="send"]'];
      for (const pat of clsPatterns) { const el = container.querySelector(pat); if (el && el.offsetParent !== null) { submitBtn = el; break; } }
      if (!submitBtn) {
        const btns = container.querySelectorAll('button, [role="button"], span[role="button"]');
        for (const btn of btns) { const t = (btn.textContent || '').trim(); if (/^(发送|评论|提交|发布|发表|回复|确定)$|^submit$|^post$/i.test(t) && btn.offsetParent !== null) { submitBtn = btn; break; } }
      }
      if (!submitBtn) submitBtn = container.querySelector('[aria-label*="发送"], [aria-label*="提交"], [aria-label*="发布"], [aria-label*="submit"], [aria-label*="send"]');
    }
    if (!submitBtn) { let node = inputEl.parentElement; for (let i = 0; i < 12 && node && !submitBtn; i++) { const btn = node.querySelector('button, span[role="button"], [class*="submit"], [class*="send"], [class*="publish"], [class*="active"]'); if (btn && btn.offsetParent !== null) submitBtn = btn; node = node.parentElement; } }
    if (!submitBtn) submitBtn = document.querySelector('button[type="submit"]');
    if (!submitBtn) { const candidates = document.querySelectorAll('button, [role="button"], span, div, a'); for (const el of candidates) { const t = (el.textContent || '').trim().replace(/\s+/g, ''); if (/^(发送|评论|提交|发布|发表|回复)$|^submit$|^post$/i.test(t) && el.offsetParent !== null) { submitBtn = el; break; } } }
    if (!submitBtn) { const globalPatterns = ['[class*="submit-btn"]', '[class*="send-btn"]', '[class*="publish-btn"]', '[class*="comment-submit"]', '[class*="reply-submit"]', 'button[class*="active"]', 'span[class*="active"]', 'div[class*="active"]', '[class*="btn-send"]', '[class*="btn-submit"]', '[class*="btn-publish"]']; for (const pat of globalPatterns) { const el = document.querySelector(pat); if (el && el.offsetParent !== null) { submitBtn = el; break; } } }

    if (submitBtn && !submitBtn.disabled) {
      submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
      submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
      submitBtn.click();
      return { ok: true, reason: '已提交' };
    } else if (submitBtn && submitBtn.disabled) {
      return { ok: false, reason: '提交按钮禁用中' };
    } else {
      ['keydown', 'keypress', 'keyup'].forEach(type => inputEl.dispatchEvent(makeEnterEvent(type)));
      return { ok: true, reason: '已尝试Enter键提交' };
    }
  }

  // ============================================================
  //  注册所有内置动作
  // ============================================================

  // — 导航 —
  registry.register('scroll_up', async (p) => { window.scrollBy({ top: -(p.amount || 300), behavior: 'smooth' }); return { ok: true }; }, { description: '向上滚动', icon: '⬆', category: 'navigation', reversible: true });
  registry.register('scroll_down', async (p) => { window.scrollBy({ top: p.amount || 300, behavior: 'smooth' }); return { ok: true }; }, { description: '向下滚动', icon: '⬇', category: 'navigation', reversible: true });
  registry.register('scroll_to_top', async () => { window.scrollTo({ top: 0, behavior: 'smooth' }); return { ok: true }; }, { description: '回到顶部', icon: '⏫', category: 'navigation', reversible: true });
  registry.register('scroll_to_bottom', async () => { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return { ok: true }; }, { description: '滚动到底部', icon: '⏬', category: 'navigation', reversible: true });
  registry.register('refresh', async () => { location.reload(); return { ok: true }; }, { description: '刷新页面', icon: '🔄', category: 'navigation', confirmable: true });
  registry.register('go_back', async () => { history.back(); return { ok: true }; }, { description: '后退', icon: '⬅', category: 'navigation', reversible: true });
  registry.register('go_forward', async () => { history.forward(); return { ok: true }; }, { description: '前进', icon: '➡', category: 'navigation', reversible: true });

  // — 缩放 —
  registry.register('zoom_in', async () => {
    const cur = parseFloat(document.body.style.zoom) || 1;
    document.body.style.zoom = Math.min(cur + 0.1, 2.5);
    return { ok: true };
  }, { description: '放大页面', icon: '🔍', category: 'display', reversible: true });
  registry.register('zoom_out', async () => {
    const cur = parseFloat(document.body.style.zoom) || 1;
    document.body.style.zoom = Math.max(cur - 0.1, 0.3);
    return { ok: true };
  }, { description: '缩小页面', icon: '🔎', category: 'display', reversible: true });
  registry.register('zoom_reset', async () => {
    document.body.style.zoom = 1;
    return { ok: true };
  }, { description: '恢复缩放', icon: '↩', category: 'display', reversible: true });

  // — 朗读 —
  registry.register('read_page', async () => {
    const text = extractPageText();
    if (text.length < 10) return { ok: false, reason: '页面内容太少' };
    // 暂停语音识别避免自己听到自己
    bus.emit('voice:pause_recognition');
    tts.speakText(text, { rate: 1.1 });
    // 朗读结束后恢复
    const checkDone = setInterval(() => {
      if (!tts.isSpeaking()) {
        clearInterval(checkDone);
        bus.emit('voice:resume_recognition');
      }
    }, 500);
    return { ok: true };
  }, { description: '朗读页面', icon: '🔊', category: 'display' });
  registry.register('stop_reading', async () => {
    tts.stop();
    bus.emit('voice:resume_recognition');
    return { ok: true };
  }, { description: '停止朗读', icon: '🔇', category: 'display' });

  // — 查找 —
  // 在页面文本节点中搜索关键词，创建可见的黄色高亮 + 蓝色选区

  /** 检查元素是否在视口内可见 */
  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 && rect.height > 0 &&
      rect.top < window.innerHeight && rect.bottom > 0 &&
      rect.left < window.innerWidth && rect.right > 0
    );
  }

  /** 沿祖先链向上检查是否有任何隐藏 */
  function isHidden(el) {
    if (!el) return true;
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.nodeType !== Node.ELEMENT_NODE) { node = node.parentElement; continue; }
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      ) return true;
      // 捕获 clip-hidden 模式 (如 .sr-only / .visually-hidden)
      if (
        style.clip === 'rect(0px, 0px, 0px, 0px)' ||
        style.clip === 'rect(0, 0, 0, 0)' ||
        style.clipPath === 'inset(50%)' ||
        style.clipPath === 'inset(100%)'
      ) return true;
      // position: absolute + 巨大负偏移（常见 off-screen 隐藏）
      if (style.position === 'absolute') {
        const l = parseFloat(style.left);
        const t = parseFloat(style.top);
        if (!isNaN(l) && !isNaN(t) && (l < -5000 || t < -5000)) return true;
      }
      if (node.getAttribute('aria-hidden') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  }

  /** 检查 mark 是否真正对用户可见（不被遮挡） */
  function isActuallyVisible(markEl) {
    if (!isInViewport(markEl)) return false;
    const rect = markEl.getBoundingClientRect();
    const cx = Math.min(rect.left + rect.width / 2, window.innerWidth - 1);
    const cy = Math.min(rect.top + rect.height / 2, window.innerHeight - 1);
    if (cx <= 0 || cy <= 0) return false;
    // 用 elementFromPoint 看该位置最顶层是不是我们的 mark
    const topEl = document.elementFromPoint(cx, cy);
    if (!topEl) return false;
    // topEl 可能不是 mark 本身，但只要是 mark 的子孙或祖先就算可见
    return markEl.contains(topEl) || topEl.contains(markEl) || topEl === markEl;
  }

  function findAndHighlight(text) {
    // 清除旧状态
    window.getSelection().removeAllRanges();
    document.querySelectorAll('.voice-ext-highlight').forEach(el => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      }
    });

    const lower = text.toLowerCase();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) => {
          const parent = n.parentElement;
          // 跳过隐藏/不可渲染元素、脚本/样式、本扩展自身的 UI
          if (!parent || isHidden(parent)) return NodeFilter.FILTER_REJECT;
          if (['SCRIPT','STYLE','NOSCRIPT','MARK'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.closest('#voice-ext-container')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let count = 0;
    let firstRange = null;
    let node;
    while ((node = walker.nextNode())) {
      const content = node.textContent;
      const idx = content.toLowerCase().indexOf(lower);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + text.length);

        if (!firstRange) firstRange = range.cloneRange();

        const mark = document.createElement('mark');
        mark.className = 'voice-ext-highlight';
        mark.style.cssText =
          'background:#ffeb3b;color:#000;border-radius:2px;' +
          'padding:0 1px;';
        try {
          range.surroundContents(mark);
        } catch (_) {
          // 跨节点文本无法包裹，跳过
          continue;
        }
        count++;
      }
    }

    // 判断有多少高亮实际在视口中可见
    let visibleCount = 0;
    if (count > 0) {
      const marks = document.querySelectorAll('.voice-ext-highlight');
      marks.forEach(m => { if (isActuallyVisible(m)) visibleCount++; });

      if (firstRange && visibleCount > 0) {
        const sel = window.getSelection();
        sel.addRange(firstRange);

        // 滚动到可见区域
        const rect = firstRange.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight || rect.top > window.innerHeight * 0.8) {
          firstRange.startContainer.parentElement?.scrollIntoView({
            behavior: 'smooth', block: 'center',
          });
        }
      }

      // 3 秒后清除高亮
      setTimeout(() => {
        document.querySelectorAll('.voice-ext-highlight').forEach(el => {
          const parent = el.parentNode;
          if (parent) {
            parent.replaceChild(document.createTextNode(el.textContent), el);
            parent.normalize();
          }
        });
      }, 3000);
    }

    return {
      found: count > 0,
      count,
      visibleCount,
      allHidden: count > 0 && visibleCount === 0,
    };
  }

  registry.register('find', async (p) => {
    const text = p.text || '';
    if (!text) return { ok: false, reason: '未指定搜索关键词' };

    const { found, count, visibleCount, allHidden } = findAndHighlight(text);

    if (!found) {
      return { ok: false, reason: `未找到 "${text}"` };
    }

    if (allHidden) {
      return {
        ok: true,
        reason: `找到 ${count} 处但都在折叠/隐藏区域，请展开后重试`,
      };
    }

    return {
      ok: true,
      reason: visibleCount < count
        ? `找到 ${count} 处（${visibleCount} 处可见，已高亮 3 秒）`
        : `找到 ${count} 处，已高亮 3 秒`,
    };
  }, { description: '页面查找', icon: '🔍', category: 'navigation', reversible: true });

  // — 标签页 —
  registry.register('tab_new', async () => {
    const w = window.open('');
    if (!w) return { ok: false, reason: '弹窗被拦截，请允许此网站弹窗' };
    return { ok: true };
  }, { description: '新建标签页', icon: '➕', category: 'navigation' });

  // — 社交 —
  registry.register('like', async () => { const ok = findAndClickLike(); return { ok, reason: ok ? '' : '未找到点赞按钮' }; }, { description: '点赞', icon: '👍', category: 'social' });
  registry.register('comment', async (p) => {
    const commentText = p.text || '';
    if (!commentText) return { ok: false, reason: '评论内容为空' };
    if (location.hostname.includes('bilibili.com')) {
      const apiResult = await postBilibiliComment(commentText);
      if (apiResult.ok) return apiResult;
    }
    return await triggerCommentDom(commentText);
  }, { description: '发表评论', icon: '💬', category: 'social', confirmable: true });

  // — 多模态融合：指代点击 —
  // 操作手势/眼动指向的目标。target 由 controller 从 MMFusion 上下文解析后注入。
  registry.register('click_target', async (p) => {
    const t = p.target;
    if (!t) return { ok: false, reason: '没有可操作的目标' };
    var el = resolveTargetEl(t);
    if (!el) return { ok: false, reason: '目标已失效' };
    el = nearestClickable(el);  // 往上找真正可点击的包装元素
    simulateClick(el);
    return { ok: true, reason: '已点击指向目标' };
  }, { description: '点击指向目标', icon: '🎯', category: 'fusion' });

  // — 系统 —
  registry.register('undo', async () => {
    const cm = exports.contextManager;
    const u = cm && cm.popUndo();
    if (!u) return { ok: false, reason: '没有可撤销的操作' };
    try { u.undoFn(); return { ok: true, reason: '已撤销：' + u.label }; }
    catch (_) { return { ok: false, reason: '撤销失败' }; }
  }, { description: '撤销上一步', icon: '↶', category: 'system' });
  registry.register('stop_listening', async () => { bus.emit('voice:stop_requested'); return { ok: true }; }, { description: '停止监听', icon: '⏹', category: 'system' });
  registry.register('none', async (p) => { return { ok: false, reason: p.reason || '无法识别', skipped: true }; }, { description: '（忽略）', icon: '⊘', category: 'system' });

  // ============================================================
  //  ActionExecutor 类
  // ============================================================

  class ActionExecutor {
    async execute(intent, context = {}) {
      const { action } = intent;
      const handler = registry.get(action);

      bus.emit('action:will_execute', { action, intent, context });

      let result;
      if (!handler) {
        result = { ok: false, reason: `未知动作: ${action}` };
      } else {
        try {
          const { action: _, ...params } = intent;
          result = await handler(params, context);
          result = { ok: true, ...(result || {}) };
        } catch (err) {
          console.error('[VoiceExt] 执行异常:', action, err);
          result = { ok: false, reason: err.message };
        }
      }

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
  console.log('[VoiceExt] ActionExecutor initialized —', registry.list().length, 'actions');

})(window.VoiceExt);
