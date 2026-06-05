'use strict';

// ============================================================
//  EventBus — 发布/订阅事件总线
//  所有模块通过此总线松耦合通信
//  外部模块（手势/眼动）也可通过 window.VoiceExt.eventBus 订阅
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  class EventBus {
    constructor() {
      this._listeners = new Map();
    }

    /**
     * 订阅事件
     * @param {string} event
     * @param {Function} handler
     * @returns {Function} 取消订阅的函数
     */
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

    /**
     * 取消订阅
     */
    off(event, handler) {
      const set = this._listeners.get(event);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this._listeners.delete(event);
      }
    }

    /**
     * 一次性订阅
     */
    once(event, handler) {
      const wrapper = (data) => {
        handler(data);
      };
      // store wrapper reference so off works
      const unsub = this.on(event, (data) => {
        unsub();
        handler(data);
      });
      return unsub;
    }

    /**
     * 发送事件
     * @param {string} event
     * @param {*} data
     */
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

    /**
     * 清除所有监听器
     */
    removeAll() {
      this._listeners.clear();
    }

    /**
     * 列出当前所有事件名
     */
    listEvents() {
      return Array.from(this._listeners.keys());
    }
  }

  exports.eventBus = new EventBus();
  console.log('[VoiceExt] EventBus initialized');

})(window.VoiceExt);
