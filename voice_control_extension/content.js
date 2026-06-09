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
                } catch (_) { }
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
            try { document.dispatchEvent(new CustomEvent(EVT, { detail: wire })); } catch (_) { }
            return wire;
        },

        /** 订阅跨模态事件，返回取消函数 */
        subscribe: function (cb) {
            if (typeof cb !== 'function') return function () { };
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
            } catch (_) { }
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
            // 去重：同一动作已在窗口内（任意来源）→ 只执行一次
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
            if (ev.type === 'command' && ev.action) this._ingest(ev);
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

// ============================================================
//  EventBus — 模块内发布/订阅总线（仅本 world 内，松耦合通信）
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    class EventBus {
        constructor() {
            this._listeners = new Map();
        }

        /** 订阅，返回取消订阅函数 */
        on(event, handler) {
            if (typeof handler !== 'function') {
                throw new Error('[EventBus] handler must be a function');
            }
            if (!this._listeners.has(event)) {
                this._listeners.set(event, new Set());
            }
            this._listeners.get(event).add(handler);
            return () => this.off(event, handler);
        }

        off(event, handler) {
            const set = this._listeners.get(event);
            if (set) {
                set.delete(handler);
                if (set.size === 0) this._listeners.delete(event);
            }
        }

        /** 一次性订阅 */
        once(event, handler) {
            const unsub = this.on(event, (data) => {
                unsub();
                handler(data);
            });
            return unsub;
        }

        emit(event, data) {
            const set = this._listeners.get(event);
            if (!set) return;
            for (const handler of set) {
                try {
                    handler(data);
                } catch (e) {
                    console.error('[EventBus] handler error for event "' + event + '":', e);
                }
            }
        }

        removeAll() {
            this._listeners.clear();
        }

        listEvents() {
            return Array.from(this._listeners.keys());
        }
    }

    exports.eventBus = new EventBus();
    console.log('[VoiceExt] EventBus initialized');

})(window.VoiceExt);

// ============================================================
//  ActionRegistry — 动作注册表
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    class ActionRegistry {
        constructor() {
            this._handlers = new Map();
            this._meta = new Map();
        }

        /**
         * @param {string} name      动作名，如 'scroll_up'
         * @param {Function} handler async (params, context) => { ok, reason?, ... }
         * @param {object} [meta]    { description, icon?, category?, confirmable?, reversible? }
         */
        register(name, handler, meta = {}) {
            if (typeof handler !== 'function') {
                throw new Error('[ActionRegistry] handler for "' + name + '" must be a function');
            }
            if (this._handlers.has(name)) {
                console.warn('[ActionRegistry] overwriting handler for:', name);
            }
            this._handlers.set(name, handler);
            this._meta.set(name, {
                description: '',
                icon: '▶',
                category: 'general',
                ...meta,
            });
        }

        unregister(name) {
            this._handlers.delete(name);
            this._meta.delete(name);
        }

        get(name) {
            return this._handlers.get(name);
        }

        has(name) {
            return this._handlers.has(name);
        }

        list() {
            return Array.from(this._handlers.keys());
        }

        getMeta(name) {
            return this._meta.get(name) || {};
        }

        /** 列出所有动作 + 元信息 */
        listWithMeta() {
            return Array.from(this._handlers.entries()).map(([name]) => ({
                name,
                ...this.getMeta(name),
            }));
        }

        clear() {
            this._handlers.clear();
            this._meta.clear();
        }
    }

    exports.actionRegistry = new ActionRegistry();
    console.log('[VoiceExt] ActionRegistry initialized');

})(window.VoiceExt);

// ============================================================
//  IntentMatcher — 本地意图匹配器
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    // ---- 归一化 ----
    function fullToHalf(s) {
        return s.replace(/[！-～]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        }).replace(/　/g, ' ');
    }
    function stripTrailingPunct(s) {
        return s.replace(/[。，！？、~,.!?；;：:\s]+$/g, '');
    }
    function stripFillers(s) {
        return s
            .replace(/^(请|帮我|麻烦你?|我想要?|我要|给我|能不能|帮)/, '')
            .replace(/(谢谢|吧|呢|啊|嘛|哦|喔)$/, '')
            .trim();
    }

    // ---- 关键词表 ----

    // Tier A：停止/否定（必须先于对应正向词）
    const STOP_READING = ['别读了', '别念了', '停止朗读', '别读', '别念', '闭嘴', '不要读', '不用读了'];
    const STOP_LISTENING = ['停止监听', '关闭语音', '别听了', '退下', '休息吧', '关掉语音', '不用听了', '停止监听了'];

    // Tier A：追问/控制（→ __followup__ sentinel）
    const FU_UNDO = ['撤销', '撤回', '返回上一步', '退回去', '撤一下', '回退', '撤销刚才'];
    const FU_REPEAT_LAST = ['重复', '再来一次', '再执行一次', '刚才那个再来', '一样的再来', '再做一次'];
    // 无方向词的"再继续"类（带方向的"再往下"由 Tier D scroll 自然命中）
    const FU_REPEAT_DIR = ['继续', '再来', '再来点', '再多一点', '再多滚', '接着', '接着滚', '再滚一点', '再多点'];
    // confirm/cancel 用「整句精确相等」匹配，避免子串误触（"好的往下滚"不应判为确认）
    const CONFIRM_WORDS = ['是', '是的', '对', '对的', '好', '好的', '可以', '确认', '确定', '嗯', '行', '没错'];
    const CANCEL_WORDS = ['否', '不', '不要', '取消', '算了', '不用', '不是', '不对'];

    // Tier B：指代（需配合动词）
    const DEIXIS_TOKENS = ['这个', '那个', '这里', '那里', '这儿', '那儿', '它', '这', '那'];
    const DEIXIS_VERBS = ['点击', '点', '打开', '选中', '选这个', '选', '激活', '按一下', '按'];

    // Tier C：带参（从原文抽）—— 触发词按「长在前」排，先消费长触发词
    const COMMENT_TRIGGERS = ['评论说', '评价说', '留言说', '发评论', '发个评论', '评论', '评价', '留言'];
    const FIND_TRIGGERS = ['查找', '搜索', '找一下', '找找', '定位到', '找到', '找'];

    // Tier D：简单动词（无参）。每个动作一组关键词，组间不应交叉。
    const SIMPLE = [
        ['scroll_down', ['往下滚', '向下滚', '下滑', '往下', '下翻', '滚下去', '向下']],
        ['scroll_up', ['往上滚', '向上滚', '上滑', '往上', '上翻', '向上']],
        ['scroll_to_top', ['回到顶部', '到顶部', '最上面', '回顶', '顶部']],
        ['scroll_to_bottom', ['到底部', '滚到底', '最下面', '拉到底', '底部']],
        ['refresh', ['刷新', '重新加载', '刷一下']],
        ['go_back', ['后退', '返回', '上一页']],
        ['go_forward', ['前进', '下一页']],
        ['zoom_in', ['放大', '字太小', '大一点', '放大一点']],
        ['zoom_out', ['缩小', '字太大', '小一点', '缩小一点']],
        ['zoom_reset', ['恢复大小', '正常大小', '原始比例', '默认缩放', '恢复缩放']],
        ['read_page', ['朗读', '读一下', '念给我', '读页面', '念一下', '读给我']],
        ['like', ['点赞', '赞一下', '给个赞']],
        ['tab_new', ['新建标签', '新标签页', '打开新页面', '新建页面']],
    ];

    function includesAny(text, list) {
        for (let i = 0; i < list.length; i++) {
            if (text.indexOf(list[i]) >= 0) return list[i];
        }
        return null;
    }

    /** 在 text 中找到第一个触发词，返回其后内容 { trigger, rest } | null */
    function extractAfter(text, triggers) {
        let best = null;
        for (let i = 0; i < triggers.length; i++) {
            const idx = text.indexOf(triggers[i]);
            if (idx >= 0 && (!best || idx < best.idx)) {
                best = { idx, trigger: triggers[i] };
            }
        }
        if (!best) return null;
        return { trigger: best.trigger, rest: text.slice(best.idx + best.trigger.length) };
    }

    function cleanParam(s) {
        return s
            .replace(/^(说|一下|一点|到|了|的|下|：|:)+/, '')
            .replace(/["'""'']/g, '')
            .trim();
    }

    class IntentMatcher {
        /**
         * @param {string} transcript
         * @returns {object|null}
         */
        match(transcript) {
            if (!transcript) return null;

            const cleaned = fullToHalf(transcript).replace(/\s+/g, '');         // 抽参用（保留内容）
            const raw = stripTrailingPunct(cleaned);
            const norm = stripFillers(raw).toLowerCase();                        // 匹配用
            if (!norm) return null;

            // ===== Tier A：停止/否定 =====
            if (includesAny(norm, STOP_READING)) return { action: 'stop_reading', source: 'local' };
            if (includesAny(norm, STOP_LISTENING)) return { action: 'stop_listening', source: 'local' };

            // ===== Tier A：追问/控制 =====
            if (includesAny(norm, FU_UNDO)) return { action: '__followup__', kind: 'undo', source: 'context' };
            if (includesAny(norm, FU_REPEAT_LAST)) return { action: '__followup__', kind: 'repeat_last', source: 'context' };
            if (includesAny(norm, FU_REPEAT_DIR)) return { action: '__followup__', kind: 'repeat_dir', source: 'context' };
            // confirm/cancel：整句精确相等，避免误触
            if (CONFIRM_WORDS.indexOf(norm) >= 0) return { action: '__followup__', kind: 'confirm', source: 'context' };
            if (CANCEL_WORDS.indexOf(norm) >= 0) return { action: '__followup__', kind: 'cancel', source: 'context' };

            // ===== Tier B：指代（需 指代词 + 动词）=====
            if (includesAny(norm, DEIXIS_TOKENS) && includesAny(norm, DEIXIS_VERBS)) {
                return { action: 'click_target', source: 'local' };
            }

            // ===== Tier C：带参（find / comment），抽到非空内容即短路 =====
            const cm = extractAfter(cleaned, COMMENT_TRIGGERS);
            if (cm) {
                const text = cleanParam(cm.rest);
                if (text) return { action: 'comment', text: text, source: 'local' };
            }
            const fd = extractAfter(cleaned, FIND_TRIGGERS);
            if (fd) {
                const text = cleanParam(fd.rest);
                if (text) return { action: 'find', text: text, source: 'local' };
            }

            // ===== Tier D：简单动词，≥2 个不同动作命中视为歧义 → null（落 LLM）=====
            const hits = [];
            for (let i = 0; i < SIMPLE.length; i++) {
                if (includesAny(norm, SIMPLE[i][1])) hits.push(SIMPLE[i][0]);
            }
            if (hits.length === 1) return { action: hits[0], source: 'local' };

            // 多命中（歧义）或零命中 → 交给 LLM
            return null;
        }
    }

    exports.intentMatcher = new IntentMatcher();
    console.log('[VoiceExt] IntentMatcher initialized');

})(window.VoiceExt);

// ============================================================
//  LLMClient — DeepSeek API 语义理解
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    const DEEPSEEK_BASE = 'https://api.deepseek.com/v1/chat/completions';
    const MODEL = 'deepseek-v4-flash';

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
{"action":"zoom_in"}
{"action":"zoom_out"}
{"action":"zoom_reset"}
{"action":"read_page"}
{"action":"stop_reading"}
{"action":"find","text":"要查找的关键词"}
{"action":"click_target"}
{"action":"tab_new"}
{"action":"stop_listening"}
{"action":"none","reason":"无法识别的原因"}

action 说明：

■ 页面操作：
- scroll_up / scroll_down: amount 为滚动像素数，默认 300
- scroll_to_top / scroll_to_bottom: 滚动到页面顶部/底部
- refresh: 刷新当前页面
- go_back / go_forward: 浏览器前进/后退

■ 缩放：
- zoom_in: 放大页面，如"放大""放大一点""字太小了"
- zoom_out: 缩小页面，如"缩小""缩小一点""字太大了"
- zoom_reset: 恢复默认缩放，如"恢复大小""正常大小""原始比例"

■ 朗读：
- read_page: 用户想听页面内容，如"读一下""朗读页面""念给我听"
- stop_reading: 停止朗读，如"别读了""停下""闭嘴""别念了" — 这些都不是 none！

■ 查找：
- find: 在当前页面搜索文字，text 为搜索关键词。
  如"查找人工智能" → {"action":"find","text":"人工智能"}
  "搜索一下联系方式" → {"action":"find","text":"联系方式"}

■ 指代点击（多模态）：
- click_target: 用户用指代词指向某个目标并要点击，如"点这个""打开它""选中那个""激活这个"。
  目标位置由手势/眼动模块提供，你只需返回 {"action":"click_target"}。

■ 标签页：
- tab_new: 打开新标签页，如"新建标签""打开新页面"

■ 社交互动：
- like: 用户想点赞，需找到并点击页面中的点赞按钮

■ 评论功能：
- comment: 用户想对当前页面/帖子发表评论，text 是从用户语音中提取出的评论正文。
  如"评论太棒了" → {"action":"comment","text":"太棒了"}
  "评论说写得真好" → {"action":"comment","text":"写得真好"}
  text 只包含评论内容，去掉"评论""说"等引导词。

■ 停止监听：
- stop_listening: 用户想结束语音控制，如"停止监听""关闭语音""别听了""退下""休息吧"
  这些都不是 none，必须返回 {"action":"stop_listening"}

■ 忽略：
- none: 无法识别或不需要操作，需附带 reason`;

    class LLMClient {
        constructor(apiKey) {
            this._apiKey = apiKey || '';
        }

        setApiKey(key) { this._apiKey = key; }
        hasApiKey() { return !!this._apiKey; }

        async interpret(transcript) {
            if (!this._apiKey) throw new Error('未设置 API Key');

            const res = await fetch(DEEPSEEK_BASE, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._apiKey}`
                },
                body: JSON.stringify({
                    model: MODEL,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: transcript }
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
    }

    exports.llmClient = new LLMClient();
    console.log('[VoiceExt] LLMClient initialized');

})(window.VoiceExt);

// ============================================================
//  SpeechRecognizer — 浏览器语音识别封装
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    class SpeechRecognizer {
        constructor(options = {}) {
            this._lang = options.lang || 'zh-CN';
            this._continuous = options.continuous || false;
            this._interimResults = options.interimResults || false;
            this._recognition = null;
            this._isListening = false;
            this._restartOnEnd = false;
            this._restartTimer = null;
            this._disposed = false;
            this._networkErrors = 0;      // 连续网络错误计数
            this._maxNetworkRetries = 5;  // 最多连续重试次数

            // 供外部设置，语音暂停回调（如TTS播放时暂停识别）
            this.onShouldPause = null;
        }

        init() {
            if (this._disposed) return false;

            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                console.error('[SpeechRecognizer] 浏览器不支持 SpeechRecognition');
                return false;
            }

            if (!this._recognition) {
                this._recognition = new SpeechRecognition();
                this._recognition.lang = this._lang;
                this._recognition.interimResults = this._interimResults;
                this._recognition.continuous = this._continuous;
                this._bindEvents();
            }

            return true;
        }

        start() {
            if (this._disposed || !this._recognition) return;
            this._networkErrors = 0;  // 重置网络错误计数
            this._restartOnEnd = true;
            this._isListening = true;
            try {
                this._recognition.start();
            } catch (_) { /* already started */ }
            exports.eventBus.emit('speech:start');
        }

        stop() {
            this._restartOnEnd = false;
            this._isListening = false;
            if (this._restartTimer) {
                clearTimeout(this._restartTimer);
                this._restartTimer = null;
            }
            if (this._recognition) {
                try { this._recognition.stop(); } catch (_) { }
            }
            exports.eventBus.emit('speech:stop');
        }

        /** 暂停（TTS 播报时用），与 stop 不同：不改变 restartOnEnd 状态 */
        pause() {
            this._isListening = false;
            if (this._recognition) {
                try { this._recognition.stop(); } catch (_) { }
            }
        }

        /** 从暂停恢复 */
        resume() {
            this._isListening = true;
            try {
                this._recognition.start();
            } catch (_) { }
            exports.eventBus.emit('speech:start');
        }

        isListening() { return this._isListening; }

        setLanguage(lang) {
            this._lang = lang;
            if (this._recognition) this._recognition.lang = lang;
        }

        dispose() {
            this._disposed = true;
            this.stop();
            this._recognition = null;
        }

        // ---- 内部 ----

        _bindEvents() {
            const rec = this._recognition;
            const bus = exports.eventBus;

            rec.onresult = (evt) => {
                const result = evt.results[evt.results.length - 1][0];
                const transcript = result.transcript.trim();
                const confidence = result.confidence;

                if (!transcript) return;

                // 成功收到识别结果，重置网络错误计数
                this._networkErrors = 0;

                bus.emit('speech:result', {
                    transcript,
                    confidence,
                    isFinal: evt.results[evt.results.length - 1].isFinal,
                });
            };

            rec.onerror = (e) => {
                // 静默处理：无语音 / 主动中断
                if (e.error === 'no-speech' || e.error === 'aborted') {
                    bus.emit('speech:error', { error: e.error, silent: true });
                    this._restartIfActive();
                    return;
                }

                // 网络错误：退避重试，不弹窗骚扰用户
                if (e.error === 'network') {
                    this._networkErrors++;
                    if (this._networkErrors <= this._maxNetworkRetries) {
                        // 退避时间随错误次数增长：1s, 2s, 4s, 8s, 16s
                        const delay = Math.min(1000 * Math.pow(2, this._networkErrors - 1), 30000);
                        console.warn('[SpeechRecognizer] 网络错误 #' + this._networkErrors +
                            '，将在 ' + (delay / 1000) + 's 后重试...');
                        if (this._restartTimer) clearTimeout(this._restartTimer);
                        this._restartTimer = setTimeout(() => {
                            this._restartIfActive();
                        }, delay);
                    } else {
                        console.error('[SpeechRecognizer] 连续网络错误超过 ' +
                            this._maxNetworkRetries + ' 次，停止重试。请检查网络连接。');
                        this._restartOnEnd = false;
                        this._isListening = false;
                        bus.emit('speech:error', {
                            error: 'network',
                            message: '语音服务不可用（网络连接问题），请检查网络',
                            silent: false,
                            fatal: true,
                        });
                    }
                    return;
                }

                // 权限拒绝
                if (e.error === 'not-allowed') {
                    bus.emit('speech:error', {
                        error: 'not-allowed',
                        message: '未授权麦克风，请在浏览器设置中允许',
                        silent: false,
                        fatal: true,
                    });
                    this._restartOnEnd = false;
                    this._isListening = false;
                    return;
                }

                // 其他严重错误
                bus.emit('speech:error', { error: e.error, message: e.message, silent: false });
                this._restartIfActive();
            };

            rec.onend = () => {
                this._isListening = false;
                bus.emit('speech:end');

                // 持续模式：自动重新开始
                if (this._restartOnEnd && !this._disposed) {
                    this._restartTimer = setTimeout(() => {
                        if (this._restartOnEnd && !this._disposed) {
                            // TTS 播放时不重启
                            if (this.onShouldPause && this.onShouldPause()) {
                                return;
                            }
                            try {
                                this._recognition.start();
                                this._isListening = true;
                            } catch (_) { }
                        }
                    }, this._continuous ? 150 : 300);
                }
            };
        }

        _restartIfActive() {
            if (!this._restartOnEnd || this._disposed) return;
            if (this._restartTimer) clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
                if (this._restartOnEnd && !this._disposed) {
                    if (this.onShouldPause && this.onShouldPause()) return;
                    try {
                        this._recognition.start();
                        this._isListening = true;
                    } catch (_) { }
                }
            }, 300);
        }
    }

    exports.speechRecognizer = new SpeechRecognizer({ lang: 'zh-CN' });
    console.log('[VoiceExt] SpeechRecognizer initialized');

})(window.VoiceExt);

// ============================================================
//  TTSManager — 语音合成（TTS）管理
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    /** 简短操作反馈短语映射 */
    const FEEDBACK_MAP = {
        scroll_up: '好的',
        scroll_down: '好的',
        scroll_to_top: '已回到顶部',
        scroll_to_bottom: '已到达底部',
        refresh: '正在刷新',
        go_back: '后退',
        go_forward: '前进',
        like: '已点赞',
        zoom_in: '已放大',
        zoom_out: '已缩小',
        zoom_reset: '已恢复',
        stop_reading: '已停止',
        stop_listening: '已退出',
    };

    /** 叮咚提示音（通过 AudioContext 生成简单提示音） */
    function playChime(type = 'activate') {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (type === 'activate') {
                // 上升音：叮～
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                osc.frequency.linearRampToValueAtTime(1100, ctx.currentTime + 0.15);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.3);
            } else if (type === 'deactivate') {
                // 下降音：咚～
                osc.type = 'sine';
                osc.frequency.setValueAtTime(660, ctx.currentTime);
                osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.2);
                gain.gain.setValueAtTime(0.25, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.35);
            } else if (type === 'error') {
                // 低沉短促两声
                osc.type = 'square';
                osc.frequency.setValueAtTime(220, ctx.currentTime);
                gain.gain.setValueAtTime(0.15, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.15);

                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.type = 'square';
                osc2.frequency.setValueAtTime(180, ctx.currentTime + 0.2);
                gain2.gain.setValueAtTime(0.12, ctx.currentTime + 0.2);
                gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
                osc2.start(ctx.currentTime + 0.2);
                osc2.stop(ctx.currentTime + 0.35);
            }

            // 自动清理
            setTimeout(() => { ctx.close().catch(() => { }); }, 500);
        } catch (_) { /* AudioContext not available */ }
    }

    class TTSManager {
        constructor() {
            this._enabled = false;  // 默认关闭，需用户在设置中手动开启
            this._voice = null;
            this._pendingSetup = false;
        }

        /**
         * 初始化语音列表（需要在用户手势后调用）
         */
        init() {
            if (this._pendingSetup) return;
            this._pendingSetup = true;

            // 在 speak 首次调用时才真正初始化语音
            const tryLoadVoices = () => {
                const voices = speechSynthesis.getVoices();
                if (voices.length > 0) {
                    this._voice = voices.find(v => v.lang.startsWith('zh')) || voices[0];
                    this._pendingSetup = false;
                }
            };

            tryLoadVoices();
            speechSynthesis.onvoiceschanged = tryLoadVoices;
        }

        /** 开启/关闭 TTS */
        setEnabled(enabled) {
            this._enabled = !!enabled;
            if (!this._enabled) this.stop();
        }

        isEnabled() {
            return this._enabled;
        }

        /**
         * 播报操作反馈
         * @param {string} action — 动作名，会查找 FEEDBACK_MAP
         * @param {string} [customText] — 自定义文本（如评论内容朗读）
         */
        speak(action, customText) {
            if (!this._enabled) return;

            const text = customText || FEEDBACK_MAP[action];
            if (!text) return;

            this._speakText(text);
        }

        /**
         * 朗读任意文本（用于 read_page）
         * @param {string} text
         * @param {object} [options]
         */
        speakText(text, options = {}) {
            if (!this._enabled || !text) return;
            this._speakText(text, options);
        }

        /** 停止朗读 */
        stop() {
            try { speechSynthesis.cancel(); } catch (_) { }
        }

        /** 是否正在朗读 */
        isSpeaking() {
            return speechSynthesis.speaking;
        }

        /**
         * 播放提示音
         */
        playChime(type) {
            playChime(type);
        }

        // ---- 内部 ----

        _speakText(text, options = {}) {
            if (!this._voice) {
                // 再次尝试获取语音
                const voices = speechSynthesis.getVoices();
                this._voice = voices.find(v => v.lang.startsWith('zh')) || voices[0];
            }

            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = options.lang || 'zh-CN';
            utterance.rate = options.rate || 1.0;
            utterance.pitch = options.pitch || 1.0;
            utterance.volume = options.volume || 0.8;
            if (this._voice) utterance.voice = this._voice;

            try { speechSynthesis.speak(utterance); } catch (_) { }
        }
    }

    exports.ttsManager = new TTSManager();
    console.log('[VoiceExt] TTSManager initialized');

})(window.VoiceExt);

// ============================================================
//  ContextManager — 上下文记忆
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    const HISTORY_CAP = 10;
    const UNDO_CAP = 10;

    // 不可重复的动作（"重复"对它们没意义）
    const NON_REPEATABLE = new Set(['stop_listening', 'refresh', 'none', 'click_target', '__followup__']);

    class ContextManager {
        constructor() {
            this._history = [];        // [{transcript, action, params, source, ok, ts}]
            this._undoStack = [];      // [{label, undoFn, ts}]
            this._lastDirection = null; // 'up' | 'down' | null
        }

        /** 记录一次已执行的指令 */
        record(intent, result, meta = {}) {
            const { action } = intent || {};
            if (!action || action === '__followup__') return;
            const { action: _a, source: _s, ...params } = intent;
            this._history.push({
                transcript: meta.transcript || '',
                action,
                params,
                source: intent.source || 'unknown',
                ok: !!(result && result.ok),
                ts: Date.now(),
            });
            if (this._history.length > HISTORY_CAP) this._history.shift();

            if (action === 'scroll_down' || action === 'scroll_to_bottom') this._lastDirection = 'down';
            else if (action === 'scroll_up' || action === 'scroll_to_top') this._lastDirection = 'up';
        }

        getLast() {
            return this._history.length ? this._history[this._history.length - 1] : null;
        }

        getHistory() { return this._history.slice(); }

        /**
         * 解析追问 → 具体 intent | null
         * @param {'repeat_last'|'repeat_dir'} kind
         */
        resolveFollowup(kind) {
            if (kind === 'repeat_last') {
                const last = this.getLast();
                if (!last || NON_REPEATABLE.has(last.action)) return null;
                return Object.assign({ action: last.action, source: 'context' }, last.params);
            }
            if (kind === 'repeat_dir') {
                // 按上次方向再滚一次（无历史则默认向下），用较小步长更跟手
                const dir = this._lastDirection || 'down';
                const action = dir === 'up' ? 'scroll_up' : 'scroll_down';
                return { action, amount: 200, source: 'context' };
            }
            return null;
        }

        /**
         * 在「执行前」生成撤销闭包（快照当前状态）。
         * @returns {{label:string, undoFn:Function} | null}  null = 该动作不可撤销
         */
        buildUndo(intent) {
            const action = intent && intent.action;
            switch (action) {
                case 'scroll_up':
                case 'scroll_down':
                case 'scroll_to_top':
                case 'scroll_to_bottom': {
                    const prevY = window.scrollY;
                    return { label: '滚动', undoFn: () => window.scrollTo({ top: prevY, behavior: 'smooth' }) };
                }
                case 'zoom_in':
                case 'zoom_out':
                case 'zoom_reset': {
                    const prevZoom = document.body.style.zoom || '';
                    return { label: '缩放', undoFn: () => { document.body.style.zoom = prevZoom; } };
                }
                case 'go_back':
                    return { label: '后退', undoFn: () => history.forward() };
                case 'go_forward':
                    return { label: '前进', undoFn: () => history.back() };
                case 'find':
                    return { label: '查找高亮', undoFn: () => clearFindHighlight() };
                // 不可逆：refresh / like / comment / tab_new / read_page / stop_* / click_target / none
                default:
                    return null;
            }
        }

        pushUndo(undoFn, label) {
            if (typeof undoFn !== 'function') return;
            this._undoStack.push({ undoFn, label: label || '操作', ts: Date.now() });
            if (this._undoStack.length > UNDO_CAP) this._undoStack.shift();
        }

        popUndo() {
            return this._undoStack.length ? this._undoStack.pop() : null;
        }

        canUndo() { return this._undoStack.length > 0; }

        clear() {
            this._history.length = 0;
            this._undoStack.length = 0;
            this._lastDirection = null;
        }
    }

    /** 清除 find 动作留下的高亮（与 action-executor 中的清理逻辑一致） */
    function clearFindHighlight() {
        try {
            window.getSelection().removeAllRanges();
            document.querySelectorAll('.voice-ext-highlight').forEach(el => {
                const parent = el.parentNode;
                if (parent) {
                    parent.replaceChild(document.createTextNode(el.textContent), el);
                    parent.normalize();
                }
            });
        } catch (_) { }
    }

    exports.contextManager = new ContextManager();
    console.log('[VoiceExt] ContextManager initialized');

})(window.VoiceExt);

// ============================================================
//  ActionExecutor — 动作执行引擎
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
            try { const el = document.querySelector(t.selector); if (el) return el; } catch (_) { }
        }
        if (t.point && typeof t.point.x === 'number') {
            const el = document.elementFromPoint(t.point.x, t.point.y);
            if (el) return el;
        }
        return null;
    }

    /** 在元素上模拟一次真实点击（复用手势模块的 simulateClick 模式） */
    function simulateClick(el) {
        try { el.focus && el.focus(); } catch (_) { }
        let x = 0, y = 0;
        try { const r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; } catch (_) { }
        ['mousedown', 'mouseup', 'click'].forEach(type => {
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
        for (const fn of idCandidates) { try { const r = fn(); if (r) { oid = r; break; } } catch (_) { } }

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
                    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'MARK'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
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
        const el = resolveTargetEl(t);
        if (!el) return { ok: false, reason: '目标已失效' };
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

// ============================================================
//  UIManager — UI 组件（麦克风按钮、模式指示灯、设置面板、Toast）
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

    const bus = exports.eventBus;

    class UIManager {
        constructor() {
            this._container = null;
            this._toastTimer = null;
            this._elements = {};
            this._ttsEnabled = false;
        }

        inject() {
            if (document.getElementById('voice-ext-container')) return;

            const container = document.createElement('div');
            container.id = 'voice-ext-container';
            container.innerHTML = `
        <div id="voice-ext-toast"></div>
        <div id="voice-ext-settings">
          <label>DeepSeek API Key</label>
          <input id="voice-ext-apikey" type="password" placeholder="sk-..." autocomplete="off">
          <div class="settings-row">
            <span>语音反馈 (TTS)</span>
            <button id="voice-ext-tts-toggle" class="settings-toggle off" title="开关语音播报"></button>
          </div>
          <div class="settings-row">
            <span>唤醒词模式</span>
            <button id="voice-ext-wake-toggle" class="settings-toggle off" title="说"小助手"激活"></button>
          </div>
          <div class="btn-row">
            <button class="btn-cancel" id="voice-ext-cancel">取消</button>
            <button class="btn-save" id="voice-ext-save">保存</button>
          </div>
        </div>
        <button id="voice-ext-mic-btn" class="idle" title="开启语音控制">
          <span id="voice-ext-mode-indicator" class="passive"></span>
          语音<br>控制
        </button>
        <button id="voice-ext-gear-btn" title="设置">⚙</button>
      `;
            document.body.appendChild(container);
            this._container = container;

            this._elements = {
                micBtn: document.getElementById('voice-ext-mic-btn'),
                modeIndicator: document.getElementById('voice-ext-mode-indicator'),
                gearBtn: document.getElementById('voice-ext-gear-btn'),
                settings: document.getElementById('voice-ext-settings'),
                apiKeyInput: document.getElementById('voice-ext-apikey'),
                ttsToggle: document.getElementById('voice-ext-tts-toggle'),
                wakeToggle: document.getElementById('voice-ext-wake-toggle'),
                saveBtn: document.getElementById('voice-ext-save'),
                cancelBtn: document.getElementById('voice-ext-cancel'),
                toast: document.getElementById('voice-ext-toast'),
            };

            this._bindEvents();
            console.log('[VoiceExt] UI injected');
        }

        dispose() {
            if (this._container && this._container.parentNode) {
                this._container.parentNode.removeChild(this._container);
            }
            this._container = null;
            this._elements = {};
            if (this._toastTimer) clearTimeout(this._toastTimer);
            console.log('[VoiceExt] UI disposed');
        }

        // ---- 麦克风状态 ----

        setMicState(state) {
            const btn = this._elements.micBtn;
            if (!btn) return;

            // 允许复合 class：idle / listening / processing / error / passive / active
            btn.className = state;
            const labels = {
                idle: '语音<br>控制',
                listening: '监听<br>中',
                processing: '处理<br>中',
                error: '错误',
                passive: '待机<br>中',
                active: '就绪',
            };
            btn.innerHTML = labels[state] || labels.idle;
            // 重新插入指示灯
            const indicator = this._elements.modeIndicator;
            if (indicator && !btn.contains(indicator)) {
                btn.insertBefore(indicator, btn.firstChild);
            }
        }

        // ---- 模式指示灯 ----

        /** @param {'passive'|'active'|'off'} mode */
        setMode(mode) {
            const ind = this._elements.modeIndicator;
            if (!ind) return;
            ind.className = mode;
        }

        // ---- TTS 开关 ----

        setTtsEnabled(enabled) {
            this._ttsEnabled = enabled;
            const btn = this._elements.ttsToggle;
            if (btn) {
                btn.className = 'settings-toggle ' + (enabled ? 'on' : 'off');
            }
        }

        isTtsEnabled() { return this._ttsEnabled; }

        // ---- 唤醒词开关 ----

        setWakeEnabled(enabled) {
            const btn = this._elements.wakeToggle;
            if (btn) {
                btn.className = 'settings-toggle ' + (enabled ? 'on' : 'off');
            }
        }

        // ---- Toast ----

        showToast(msg, type) {
            const toast = this._elements.toast;
            if (!toast) return;
            if (this._toastTimer) clearTimeout(this._toastTimer);
            toast.className = type || '';
            toast.innerHTML = msg;
            requestAnimationFrame(() => toast.classList.add('show'));
            this._toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
        }

        hideToast() {
            const toast = this._elements.toast;
            if (toast) toast.classList.remove('show');
        }

        // ---- 设置面板 ----

        showSettings() { const s = this._elements.settings; if (s) s.classList.add('show'); }
        hideSettings() { const s = this._elements.settings; if (s) s.classList.remove('show'); }
        toggleSettings() { const s = this._elements.settings; if (s) s.classList.toggle('show'); }
        getApiKeyInput() { return this._elements.apiKeyInput?.value?.trim() || ''; }
        setApiKeyInput(value) { if (this._elements.apiKeyInput) this._elements.apiKeyInput.value = value; }

        // ---- 内部事件绑定 ----

        _bindEvents() {
            const els = this._elements;

            els.micBtn?.addEventListener('click', () => bus.emit('ui:mic_clicked'));

            els.gearBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                bus.emit('ui:gear_clicked');
            });

            els.saveBtn?.addEventListener('click', () => {
                const key = els.apiKeyInput?.value?.trim() || '';
                bus.emit('ui:save_apikey', { key });
            });

            els.cancelBtn?.addEventListener('click', () => bus.emit('ui:cancel_settings'));

            els.apiKeyInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const key = els.apiKeyInput?.value?.trim() || '';
                    bus.emit('ui:save_apikey', { key });
                }
            });

            // TTS 开关
            els.ttsToggle?.addEventListener('click', () => {
                this._ttsEnabled = !this._ttsEnabled;
                this.setTtsEnabled(this._ttsEnabled);
                bus.emit('ui:tts_toggled', { enabled: this._ttsEnabled });
            });

            // 唤醒词开关
            els.wakeToggle?.addEventListener('click', () => {
                const isOn = els.wakeToggle.classList.contains('on');
                const next = !isOn;
                this.setWakeEnabled(next);
                bus.emit('ui:wake_toggled', { enabled: next });
            });

            // 点击外部关闭
            document.addEventListener('click', (e) => {
                if (this._container && !this._container.contains(e.target)) {
                    bus.emit('ui:click_outside');
                }
            });
        }
    }

    exports.uiManager = new UIManager();
    console.log('[VoiceExt] UIManager initialized');

})(window.VoiceExt);

// ============================================================
//  VoiceController — 主控制器
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
                } catch (_) { }
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
        } catch (_) { }
    }

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
        } catch (_) { }
    }

    async function saveApiKey(key) {
        if (!key) return;
        apiKey = key;
        llmClient.setApiKey(key);
        try { await chrome.storage.local.set({ voice_ext_apikey: key }); } catch (_) { }
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

    /** 执行一条 intent：仲裁 → pushUndo → execute → record → publish → 反馈 */
    async function runIntent(intent, undo, transcript, confidence) {
        // 多模态仲裁：被其他模态抢先/去重则跳过
        if (fusion) {
            const verdict = fusion.arbitrate({ action: intent.action, source: 'voice', timestamp: Date.now() });
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
    const SOURCE_TAG = { local: '⚡本地', llm: '☁AI', context: '↻上下文' };

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
        if (t.selector) { try { el = document.querySelector(t.selector); } catch (_) { } }
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
            raw: { transcript: context.transcript, ok: !!(info && info.ok) },
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
        if (!apiKey) { ui.showSettings(); errorToast('请先设置 API Key'); return; }
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
        recognizer.start();
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

        // 多模态融合：订阅其他模态事件（仅观察，不重复执行手势自身的 DOM 操作）
        if (fusion) {
            const unsub = fusion.subscribe((ev) => {
                if (!ev || ev.source === 'voice') return;
                console.log('[VoiceExt] 收到', ev.source, '事件:', ev.type, ev.action || '');
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
            if (d.silent) return;
            if (d.fatal) {
                setMode('idle');
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
            console.log('[VoiceExt] Controller v1.0 initialized —',
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
                version: '1.0.0',
            };
        },
    };

    exports.controller = controller;

    // 自动启动
    controller.init().then(() => {
        recognizer.onShouldPause = () => tts.isSpeaking();
        console.log('[VoiceExt] 声控助手 v1.0 已就绪 — 点击右下角按钮开始');
    });

})(window.VoiceExt);

// ============================================================
//  GestureAdapter — 手势模块 → MMFusion 适配桥
// ============================================================
(function () {
    if (!window.MMFusion) {
        console.warn('[GestureAdapter] 未找到 MMFusion，请先加载 mmfusion-bus.js');
        return;
    }

    // 手势名 → 语音侧规范动作名（canonical action）
    // 只映射「跨模态有共同语义」的手势；视频专用手势(播放/快进/倍速)语音侧没有，略过。
    var GESTURE_TO_ACTION = {
        PALM_UP: 'scroll_up',
        PALM_DOWN: 'scroll_down',
        V_SIGN: 'refresh',
        RINGS_UP: 'like',
        POINT_LEFT: 'go_back',
        POINT_RIGHT: 'go_forward',
        // PINKY_ONLY / MIDDLE / HORNS / FREE_MODE_TOGGLE 等为手势模块自身控制/视频操作，
        // 不作为跨模态命令广播（避免误触语音侧动作）。
    };

    /**
     * 发布一条手势命令到融合总线。
     * 在手势「确认触发」的回调里调用，例如 handleContinuous 的 onConfirm 中。
     * @param {string} gestureName 手势名，如 'PALM_UP'
     * @param {number} [confidence] 0..1，缺省 0.9
     */
    window.__mmPublishGesture = function (gestureName, confidence) {
        var action = GESTURE_TO_ACTION[gestureName];
        if (!action) return;
        window.MMFusion.publish({
            source: 'gesture',
            type: 'command',
            action: action,
            confidence: typeof confidence === 'number' ? confidence : 0.9,
            raw: { gesture: gestureName },
        });
    };

    /**
     * 上报「自由模式光标」当前指向的位置（视口坐标），写入共享上下文 pointerTarget。
     * 语音说"点这个/打开它"时会从这里取目标。
     * 建议在 handleFreeModeCursor 里节流调用（如每 100ms 一次）。
     * @param {number} x 视口 X（clientX 语义）
     * @param {number} y 视口 Y（clientY 语义）
     */
    window.__mmPublishPointer = function (x, y) {
        window.MMFusion.setContext('pointerTarget', { point: { x: x, y: y } });
    };

    console.log('[GestureAdapter] 就绪 —— 在手势触发处调用 __mmPublishGesture / __mmPublishPointer');
    // 接入步骤与映射详见 FUSION.md
})();