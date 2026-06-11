'use strict';

// SpeechRecognizer wraps the browser Web Speech API and reports enough
// lifecycle detail to diagnose "green mic but no feedback" failures.
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
      this._networkErrors = 0;
      this._maxNetworkRetries = 5;
      this._noSpeechCount = 0;
      this._nextRestartDelay = 0;

      this.onShouldPause = null;
    }

    init() {
      if (this._disposed) return false;

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        console.error('[SpeechRecognizer] browser does not support SpeechRecognition');
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
      if (this._disposed || !this._recognition) {
        this._emitError('start-failed', 'Speech recognition is not initialized.', { fatal: true });
        return false;
      }

      this._networkErrors = 0;
      this._noSpeechCount = 0;
      this._restartOnEnd = true;
      this._isListening = true;

      try {
        this._recognition.start();
      } catch (err) {
        this._restartOnEnd = false;
        this._isListening = false;
        console.error('[SpeechRecognizer] start failed:', err);
        this._emitError(
          'start-failed',
          err && err.message ? err.message : 'Failed to start speech recognition.',
          { fatal: true }
        );
        return false;
      }

      exports.eventBus.emit('speech:start');
      console.info('[SpeechRecognizer] start requested');
      return true;
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

    pause() {
      this._isListening = false;
      if (this._recognition) {
        try { this._recognition.stop(); } catch (_) {}
      }
    }

    resume() {
      if (!this._recognition || this._disposed) return false;
      this._isListening = true;
      try {
        this._recognition.start();
      } catch (err) {
        console.warn('[SpeechRecognizer] resume failed:', err);
        return false;
      }
      exports.eventBus.emit('speech:start');
      return true;
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

    _bindEvents() {
      const rec = this._recognition;
      const bus = exports.eventBus;

      rec.onstart = () => {
        this._isListening = true;
        console.info('[SpeechRecognizer] recognition started');
      };

      rec.onaudiostart = () => console.info('[SpeechRecognizer] audio capture started');
      rec.onsoundstart = () => console.info('[SpeechRecognizer] sound detected');
      rec.onspeechstart = () => console.info('[SpeechRecognizer] speech detected');
      rec.onspeechend = () => console.info('[SpeechRecognizer] speech ended');
      rec.onaudioend = () => console.info('[SpeechRecognizer] audio capture ended');

      rec.onnomatch = () => {
        console.warn('[SpeechRecognizer] no recognition match');
        this._emitError('no-match', 'Speech was heard, but no text result was produced.');
      };

      rec.onresult = (evt) => {
        const speechResult = evt.results[evt.results.length - 1];
        const result = speechResult && speechResult[0];
        const transcript = result && result.transcript ? result.transcript.trim() : '';
        const confidence = result ? result.confidence : 0;

        if (!transcript) return;

        this._networkErrors = 0;
        this._noSpeechCount = 0;
        console.info('[SpeechRecognizer] result:', transcript, 'confidence:', confidence);

        bus.emit('speech:result', {
          transcript,
          confidence,
          isFinal: !!speechResult.isFinal,
        });
      };

      rec.onerror = (e) => {
        const error = e && e.error ? e.error : 'unknown';
        const message = e && e.message ? e.message : '';
        console.warn('[SpeechRecognizer] error:', error, message);

        if (error === 'aborted') {
          bus.emit('speech:error', { error, message, silent: true });
          this._restartIfActive();
          return;
        }

        if (error === 'no-speech') {
          this._noSpeechCount++;
          this._emitError(
            'no-speech',
            'No speech was detected. Check the microphone input level, then speak again.',
            { retrying: true, count: this._noSpeechCount }
          );
          this._restartIfActive();
          return;
        }

        if (error === 'network') {
          this._networkErrors++;
          if (this._networkErrors <= this._maxNetworkRetries) {
            const delay = Math.min(1000 * Math.pow(2, this._networkErrors - 1), 30000);
            this._emitError(
              'network',
              'Speech recognition network error. Retrying in ' + (delay / 1000) + 's...',
              { retrying: true, count: this._networkErrors }
            );
            this._nextRestartDelay = delay;
            if (this._restartTimer) clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
              this._restartIfActive();
            }, delay);
          } else {
            this._restartOnEnd = false;
            this._isListening = false;
            this._emitError(
              'network',
              'Speech recognition service is unavailable. Check network access to the browser speech service.',
              { fatal: true }
            );
          }
          return;
        }

        if (error === 'not-allowed' || error === 'service-not-allowed') {
          this._restartOnEnd = false;
          this._isListening = false;
          this._emitError(
            error,
            'Microphone permission or speech service permission was denied. Allow microphone access in browser site settings.',
            { fatal: true }
          );
          return;
        }

        if (error === 'audio-capture') {
          this._restartOnEnd = false;
          this._isListening = false;
          this._emitError(
            error,
            'No microphone input was captured. Check the selected input device.',
            { fatal: true }
          );
          return;
        }

        this._emitError(error, message || 'Speech recognition error.');
        this._restartIfActive();
      };

      rec.onend = () => {
        this._isListening = false;
        console.info('[SpeechRecognizer] recognition ended; restartOnEnd:', this._restartOnEnd);
        bus.emit('speech:end');

        if (this._restartOnEnd && !this._disposed) {
          if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
          }
          const delay = this._nextRestartDelay || (this._continuous ? 150 : 300);
          this._nextRestartDelay = 0;
          this._restartTimer = setTimeout(() => {
            if (!this._restartOnEnd || this._disposed) return;
            if (this.onShouldPause && this.onShouldPause()) return;
            this._tryRestart('auto-restart');
          }, delay);
        }
      };
    }

    _restartIfActive() {
      if (!this._restartOnEnd || this._disposed) return;
      if (this._restartTimer) clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => {
        if (!this._restartOnEnd || this._disposed) return;
        if (this.onShouldPause && this.onShouldPause()) return;
        this._tryRestart('restart');
      }, 300);
    }

    _tryRestart(reason) {
      try {
        this._recognition.start();
        this._isListening = true;
      } catch (err) {
        console.warn('[SpeechRecognizer] ' + reason + ' failed:', err);
      }
    }

    _emitError(error, message, extra = {}) {
      exports.eventBus.emit('speech:error', {
        error,
        message,
        silent: false,
        ...extra,
      });
    }
  }

  exports.speechRecognizer = new SpeechRecognizer({ lang: 'zh-CN' });
  console.log('[VoiceExt] SpeechRecognizer initialized');

})(window.VoiceExt);
