'use strict';

// ============================================================
//  MMFusion — 多模态融合总线 (Multi-Modal Fusion Bus)
// ============================================================
//  ★ 跨模态共享层：voice / gesture / gaze(eye) / face 都往这里发事件、读上下文
//  ★ 角色分工（见 docs/architecture.md）：
//       眼动 = focus(注视)   手势 = selection(选择)   语音 = command(命令)
//
//  关键设计 —— 为什么不用共享的 window 单例：
//  -----------------------------------------------------------
//  不同 Chrome 扩展的 content script 运行在「隔离 world」里，window 互不相通：
//    · 手势扩展是 "world":"MAIN"（页面主世界）
//    · 语音扩展是隔离 world（要用 chrome.storage，不能进 MAIN）
//  两者唯一共享的是 DOM。所以真正的总线是 document 上的 CustomEvent，
//  每个 world 各自持有一份 MMFusion facade（本地订阅 + context 缓存），
//  publish/setContext 通过 document.dispatchEvent 广播到所有 world。
//
//  跨 world 时 detail 会被 structured-clone：
//    · 绝不能放活的 DOM 元素或函数 —— 只放可序列化的 {selector?, point?:{x,y}}
//    · 对端用 document.elementFromPoint / querySelector 重新解析成活元素
//  每个 world 给事件打 origin token，忽略自己的回声，避免自激循环。
// ============================================================

(function () {
  // 幂等：本 world 已存在则复用（谁先加载谁创建）
  if (window.MMFusion) return;

  var EVT = 'mmfusion:event';      // 命令/选择/注视事件
  var CTX = 'mmfusion:context';    // 共享上下文槽更新
  var PRIORITY = { voice: 3, gesture: 2, gaze: 1, face: 0 };
  var DEDUP_WINDOW = 500;          // ms：同一动作多源去重窗口
  // 互相冲突的动作对（同时来会冲突，按优先级裁决）
  var CONFLICT_PAIRS = [
    ['scroll_up', 'scroll_down'],
    ['zoom_in', 'zoom_out'],
    ['go_back', 'go_forward'],
  ];

  function genOrigin() {
    try { return Math.random().toString(36).slice(2) + '-' + (performance.now() | 0); }
    catch (_) { return 'o-' + (new Date().getTime()); }
  }

  /** 把 target 收敛成跨 world 可序列化的形态：{selector?, point?:{x,y}} | null */
  function serializeTarget(t) {
    if (!t) return null;
    var out = {};
    if (typeof t.selector === 'string') out.selector = t.selector;
    if (t.point && typeof t.point.x === 'number' && typeof t.point.y === 'number') {
      out.point = { x: t.point.x, y: t.point.y };
    }
    // 若只给了活元素 el：尽力转成 selector，否则退化成包围盒中心点
    if (!out.selector && !out.point && t.el && t.el.nodeType === 1) {
      var sel = bestSelector(t.el);
      if (sel) out.selector = sel;
      else {
        try {
          var r = t.el.getBoundingClientRect();
          out.point = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        } catch (_) {}
      }
    }
    return (out.selector || out.point) ? out : null;
  }

  /** 给元素生成一个尽量稳定的 selector（id 优先，否则 nth-of-type 路径，限深） */
  function bestSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 4) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var sameTag = Array.prototype.filter.call(parent.children, function (c) {
        return c.tagName === node.tagName;
      });
      if (sameTag.length > 1) {
        var idx = sameTag.indexOf(node) + 1;
        parts.unshift(tag + ':nth-of-type(' + idx + ')');
      } else {
        parts.unshift(tag);
      }
      node = parent;
      depth++;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  function MMFusionBus() {
    this._origin = genOrigin();
    this._seq = 0;
    this._subs = new Set();
    this._ctx = { gazeTarget: null, pointerTarget: null, lastCommand: null };
    this._recent = [];               // 仲裁用：[{action, source, ts}]
    this._disposed = false;

    this._onEvt = this._onDomEvent.bind(this);
    this._onCtx = this._onDomContext.bind(this);
    document.addEventListener(EVT, this._onEvt);
    document.addEventListener(CTX, this._onCtx);
  }

  MMFusionBus.prototype = {
    version: '1.0.0',

    // 架构文档约定的模块化接口
    init: function () { return this; },
    onEvent: function (cb) { return this.subscribe(cb); },

    /**
     * 发布一条跨模态事件
     * @param {object} ev {source, type, action?, params?, target?, confidence?, raw?, _live?}
     *   _live=true 时本 world 订阅者拿到带活 target 的副本（仅同 world 有意义）
     */
    publish: function (ev) {
      if (this._disposed || !ev || !ev.source) return;
      var wire = {
        source: ev.source,
        type: ev.type || 'command',
        action: ev.action || null,
        params: ev.params || null,
        target: serializeTarget(ev.target),
        confidence: typeof ev.confidence === 'number' ? ev.confidence : 1,
        timestamp: Date.now(),
        raw: ev.raw || null,
        origin: this._origin,
        seq: this._seq++,
      };
      // 命令型事件计入仲裁窗口（用于去重）
      if (wire.type === 'command' && wire.action) this._ingest(wire);
      // 1) 同步通知本 world 订阅者（_live 时带活 target）
      var localCopy = ev._live ? Object.assign({}, wire, { target: ev.target || wire.target }) : wire;
      this._emitLocal(localCopy);
      // 2) 跨 world：派发序列化副本
      try { document.dispatchEvent(new CustomEvent(EVT, { detail: wire })); } catch (_) {}
      return wire;
    },

    /** 订阅跨模态事件，返回取消函数 */
    subscribe: function (cb) {
      if (typeof cb !== 'function') return function () {};
      this._subs.add(cb);
      var self = this;
      return function () { self._subs.delete(cb); };
    },

    /**
     * 设置共享上下文槽（gazeTarget / pointerTarget / lastCommand …）
     * 跨 world 广播，所有 world 镜像同一份。
     */
    setContext: function (slot, value) {
      if (this._disposed || !slot) return;
      var val = (slot === 'gazeTarget' || slot === 'pointerTarget')
        ? serializeTarget(value) : value;
      this._ctx[slot] = val;
      try {
        document.dispatchEvent(new CustomEvent(CTX, {
          detail: { slot: slot, value: val, origin: this._origin },
        }));
      } catch (_) {}
    },

    /** 读取共享上下文（浅拷贝） */
    getContext: function () { return Object.assign({}, this._ctx); },

    /**
     * 仲裁：判断某事件此刻是否应当被执行。纯函数式检查，不写入 recent
     * （recent 由 publish/远端接收自动填充）。
     * @returns {{execute:boolean, reason?:string, winner?:string}}
     */
    arbitrate: function (ev) {
      var now = (ev && ev.timestamp) || Date.now();
      this._prune(now);
      var action = ev && ev.action;
      var source = (ev && ev.source) || 'voice';
      if (!action) return { execute: true };
      // 去重：同一动作已在窗口内执行过 → 跳过
      for (var i = 0; i < this._recent.length; i++) {
        if (this._recent[i].action === action) {
          return { execute: false, reason: 'dedup', winner: this._recent[i].source };
        }
      }
      // 冲突：窗口内存在冲突动作，按优先级裁决
      for (var j = 0; j < this._recent.length; j++) {
        var r = this._recent[j];
        if (this._conflicts(r.action, action) &&
            (PRIORITY[r.source] || 0) > (PRIORITY[source] || 0)) {
          return { execute: false, reason: 'priority', winner: r.source };
        }
      }
      return { execute: true };
    },

    dispose: function () {
      this._disposed = true;
      this._subs.clear();
      this._recent.length = 0;
      document.removeEventListener(EVT, this._onEvt);
      document.removeEventListener(CTX, this._onCtx);
    },

    // ---- 内部 ----

    _emitLocal: function (ev) {
      this._subs.forEach(function (cb) {
        try { cb(ev); } catch (e) { console.error('[MMFusion] subscriber error:', e); }
      });
    },

    _onDomEvent: function (dom) {
      var ev = dom && dom.detail;
      if (!ev || ev.origin === this._origin) return;   // 忽略自己的回声
      // ★ 不在接收侧 _ingest：远端 publish 是"请求执行"而非"已执行"，只本地 publish 才写入 _recent
      this._emitLocal(ev);
    },

    _onDomContext: function (dom) {
      var d = dom && dom.detail;
      if (!d || d.origin === this._origin) return;
      this._ctx[d.slot] = d.value;
    },

    _ingest: function (ev) {
      this._recent.push({ action: ev.action, source: ev.source, ts: ev.timestamp || Date.now() });
      this._prune(ev.timestamp || Date.now());
    },

    _prune: function (now) {
      while (this._recent.length && now - this._recent[0].ts > DEDUP_WINDOW) {
        this._recent.shift();
      }
    },

    _conflicts: function (a, b) {
      if (a === b) return true;
      for (var i = 0; i < CONFLICT_PAIRS.length; i++) {
        var p = CONFLICT_PAIRS[i];
        if ((p[0] === a && p[1] === b) || (p[1] === a && p[0] === b)) return true;
      }
      return false;
    },
  };

  window.MMFusion = new MMFusionBus();
  console.log('[MMFusion] 多模态融合总线就绪 (origin=' + window.MMFusion._origin + ')');

})();
