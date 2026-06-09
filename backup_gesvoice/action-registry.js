'use strict';

// ============================================================
//  ActionRegistry — 动作注册表
//  注册式扩展：registry.register('name', handler, meta)
//  供 executor 查找执行、ui 展示；融合时其他模块也可注册/调用
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
