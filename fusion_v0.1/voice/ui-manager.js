'use strict';

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
            <button id="voice-ext-wake-toggle" class="settings-toggle off" title="说&quot;小助手&quot;激活"></button>
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
