'use strict';

// ============================================================
//  ContextManager — 上下文记忆
// ============================================================
//  让对话有"记忆"，支持追问：
//    · "继续 / 再来"         → repeat_dir：按上次方向再滚一次
//    · "重复 / 再来一次"      → repeat_last：重做上一条指令
//    · "撤销 / 撤回"          → 弹出撤销栈，还原上一个可逆动作
//
//  撤销机制 = 执行前快照 + 还原（不是反向动作）：
//    滚动→存 scrollY、缩放→存 body.zoom、导航→记 forward/back。
//    比"反向滚同样距离"可靠（平滑滚动/动量/重排/边界 clamp 都会让反向不准）。
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
    } catch (_) {}
  }

  exports.contextManager = new ContextManager();
  console.log('[VoiceExt] ContextManager initialized');

})(window.VoiceExt);
