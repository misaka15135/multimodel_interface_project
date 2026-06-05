'use strict';

// ============================================================
//  UIManager — UI 组件管理器
//  负责 DOM 注入/移除、麦克风按钮、设置面板、Toast
//  UI 事件通过 eventBus 转发，不直接操作业务逻辑
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  const bus = exports.eventBus;

  class UIManager {
    constructor() {
      this._container = null;
      this._toastTimer = null;
      this._elements = {};
    }

    /**
     * 注入 UI 到页面
     */
    inject() {
      if (document.getElementById('voice-ext-container')) return;

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
      this._container = container;

      // 缓存 DOM 引用
      this._elements = {
        micBtn: document.getElementById('voice-ext-mic-btn'),
        gearBtn: document.getElementById('voice-ext-gear-btn'),
        settings: document.getElementById('voice-ext-settings'),
        apiKeyInput: document.getElementById('voice-ext-apikey'),
        saveBtn: document.getElementById('voice-ext-save'),
        cancelBtn: document.getElementById('voice-ext-cancel'),
        toast: document.getElementById('voice-ext-toast'),
      };

      this._bindEvents();
      console.log('[VoiceExt] UI injected');
    }

    /**
     * 移除所有注入的 UI
     */
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

      btn.className = state;
      const labels = {
        idle: '语音<br>控制',
        listening: '监听<br>中',
        processing: '处理<br>中',
        error: '错误',
      };
      btn.innerHTML = labels[state] || labels.idle;
    }

    // ---- Toast ----

    showToast(msg, type) {
      const toast = this._elements.toast;
      if (!toast) return;

      if (this._toastTimer) clearTimeout(this._toastTimer);

      toast.className = type || '';
      toast.innerHTML = msg;
      requestAnimationFrame(() => toast.classList.add('show'));

      this._toastTimer = setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    hideToast() {
      const toast = this._elements.toast;
      if (toast) toast.classList.remove('show');
    }

    // ---- 设置面板 ----

    showSettings() {
      const s = this._elements.settings;
      if (s) s.classList.add('show');
    }

    hideSettings() {
      const s = this._elements.settings;
      if (s) s.classList.remove('show');
    }

    toggleSettings() {
      const s = this._elements.settings;
      if (s) s.classList.toggle('show');
    }

    /** 获取当前输入框中的 API Key */
    getApiKeyInput() {
      return this._elements.apiKeyInput?.value?.trim() || '';
    }

    /** 设置 API Key 输入框的值 */
    setApiKeyInput(value) {
      if (this._elements.apiKeyInput) {
        this._elements.apiKeyInput.value = value;
      }
    }

    // ---- 内部事件绑定 ----

    _bindEvents() {
      const els = this._elements;

      // 麦克风按钮点击 → eventBus
      els.micBtn?.addEventListener('click', () => {
        bus.emit('ui:mic_clicked');
      });

      // 设置齿轮 → eventBus
      els.gearBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        bus.emit('ui:gear_clicked');
      });

      // 保存 API Key → eventBus
      els.saveBtn?.addEventListener('click', () => {
        const key = els.apiKeyInput?.value?.trim() || '';
        bus.emit('ui:save_apikey', { key });
      });

      // 取消 → eventBus
      els.cancelBtn?.addEventListener('click', () => {
        bus.emit('ui:cancel_settings');
      });

      // 回车保存 → eventBus
      els.apiKeyInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const key = els.apiKeyInput?.value?.trim() || '';
          bus.emit('ui:save_apikey', { key });
        }
      });

      // 点击外部关闭设置面板
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
