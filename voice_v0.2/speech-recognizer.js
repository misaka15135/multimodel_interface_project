'use strict';

// ============================================================
//  SpeechRecognizer — 浏览器语音识别封装
//  生命周期: init() → start() / stop() → dispose()
//  通过 eventBus 发出 speech:result / speech:error / speech:end
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
    }

    /**
     * 初始化语音识别（在用户手势后调用以获取权限）
     * @returns {boolean} 是否支持
     */
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

    /**
     * 开始监听
     */
    start() {
      if (this._disposed || !this._recognition) return;
      this._restartOnEnd = true;
      this._isListening = true;
      try {
        this._recognition.start();
      } catch (_) {
        // 可能已经在运行中，忽略
      }
      exports.eventBus.emit('speech:start');
    }

    /**
     * 停止监听
     */
    stop() {
      this._restartOnEnd = false;
      this._isListening = false;
      if (this._restartTimer) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
      if (this._recognition) {
        try { this._recognition.stop(); } catch (_) { /* ignore */ }
      }
      exports.eventBus.emit('speech:stop');
    }

    /**
     * 是否正在监听
     */
    isListening() {
      return this._isListening;
    }

    /**
     * 释放所有资源
     */
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

        bus.emit('speech:result', {
          transcript,
          confidence,
          isFinal: evt.results[evt.results.length - 1].isFinal,
        });
      };

      rec.onerror = (e) => {
        // 静默处理的无害错误
        if (e.error === 'no-speech' || e.error === 'aborted') {
          bus.emit('speech:error', { error: e.error, silent: true });
          this._restartIfActive();
          return;
        }
        bus.emit('speech:error', { error: e.error, message: e.message, silent: false });
        this._restartIfActive();
      };

      rec.onend = () => {
        this._isListening = false;
        bus.emit('speech:end');

        // 如果仍需活跃，自动重启
        if (this._restartOnEnd && !this._disposed) {
          this._restartTimer = setTimeout(() => {
            if (this._restartOnEnd && !this._disposed) {
              try {
                this._recognition.start();
                this._isListening = true;
              } catch (_) { /* ignore */ }
            }
          }, 300);
        }
      };
    }

    _restartIfActive() {
      if (!this._restartOnEnd || this._disposed) return;
      if (this._restartTimer) clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => {
        if (this._restartOnEnd && !this._disposed) {
          try {
            this._recognition.start();
            this._isListening = true;
          } catch (_) { /* ignore */ }
        }
      }, 300);
    }
  }

  exports.speechRecognizer = new SpeechRecognizer({ lang: 'zh-CN' });
  console.log('[VoiceExt] SpeechRecognizer initialized');

})(window.VoiceExt);
