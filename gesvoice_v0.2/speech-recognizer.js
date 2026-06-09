'use strict';

// ============================================================
//  SpeechRecognizer — 浏览器语音识别封装
//  生命周期: init() → start() / stop() → dispose()
//  通过 eventBus 发出 speech:result / speech:error / speech:end
//  支持持续监听（continuous restart），唤醒词逻辑在 controller 层
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
        try { this._recognition.stop(); } catch (_) {}
      }
      exports.eventBus.emit('speech:stop');
    }

    /** 暂停（TTS 播报时用），与 stop 不同：不改变 restartOnEnd 状态 */
    pause() {
      this._isListening = false;
      if (this._recognition) {
        try { this._recognition.stop(); } catch (_) {}
      }
    }

    /** 从暂停恢复 */
    resume() {
      this._isListening = true;
      try {
        this._recognition.start();
      } catch (_) {}
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
              } catch (_) {}
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
          } catch (_) {}
        }
      }, 300);
    }
  }

  exports.speechRecognizer = new SpeechRecognizer({ lang: 'zh-CN' });
  console.log('[VoiceExt] SpeechRecognizer initialized');

})(window.VoiceExt);
