'use strict';

// ============================================================
//  EventBus — 模块内发布/订阅总线（仅本 world 内，松耦合通信）
//  注意：跨模态/跨扩展通信走 MMFusion（DOM 事件），不是这个。
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
