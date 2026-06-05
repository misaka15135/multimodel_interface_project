'use strict';

// ============================================================
//  TTSManager — 语音合成（TTS）管理
//  使用 Web Speech Synthesis API 读出操作反馈
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
      setTimeout(() => { ctx.close().catch(() => {}); }, 500);
    } catch (_) { /* AudioContext not available */ }
  }

  class TTSManager {
    constructor() {
      this._enabled = true;
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
      try { speechSynthesis.cancel(); } catch (_) {}
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

      try { speechSynthesis.speak(utterance); } catch (_) {}
    }
  }

  exports.ttsManager = new TTSManager();
  console.log('[VoiceExt] TTSManager initialized');

})(window.VoiceExt);
