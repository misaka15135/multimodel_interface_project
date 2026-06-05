'use strict';

// ============================================================
//  ActionRegistry — 动作注册表
//  注册式扩展：新增操作只需 registry.register('name', handler, meta)
//  供 action-executor 查找执行，供 ui-manager 展示可用操作列表
//  多模态融合时其他模块也可注册/调用动作
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  class ActionRegistry {
    constructor() {
      /** @type {Map<string, Function>} */
      this._handlers = new Map();
      /** @type {Map<string, object>} */
      this._meta = new Map();
    }

    /**
     * 注册一个动作
     * @param {string} name        — 动作名，如 'scroll_up'
     * @param {Function} handler   — async (params, context) => { ok, reason?, ... }
     * @param {object}   [meta]    — { description, icon?, category?, confirmable?, cooldown? }
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

    /**
     * 注销一个动作
     */
    unregister(name) {
      this._handlers.delete(name);
      this._meta.delete(name);
    }

    /**
     * 获取动作处理函数
     */
    get(name) {
      return this._handlers.get(name);
    }

    /**
     * 是否存在某个动作
     */
    has(name) {
      return this._handlers.has(name);
    }

    /**
     * 列出所有已注册动作名
     */
    list() {
      return Array.from(this._handlers.keys());
    }

    /**
     * 获取动作元信息
     */
    getMeta(name) {
      return this._meta.get(name) || {};
    }

    /**
     * 列出所有动作 + 元信息（用于 UI 渲染动作面板）
     */
    listWithMeta() {
      return Array.from(this._handlers.entries()).map(([name]) => ({
        name,
        ...this.getMeta(name),
      }));
    }

    /**
     * 清空所有注册
     */
    clear() {
      this._handlers.clear();
      this._meta.clear();
    }
  }

  exports.actionRegistry = new ActionRegistry();
  console.log('[VoiceExt] ActionRegistry initialized');

})(window.VoiceExt);
