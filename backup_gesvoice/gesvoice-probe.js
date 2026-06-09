'use strict';

// Runs in the isolated world with the voice module. It reports what the voice
// side can see through MMFusion, and can execute a click_target probe using the
// current pointerTarget written by the MAIN-world gesture simulator.
(function () {
  var EVT_RESULT = 'gesvoice:test-result';
  var EVT_REQUEST = 'gesvoice:test-request';
  var EVT_PROBE_EVENT = 'gesvoice:probe-event';

  function post(type, payload) {
    try {
      document.dispatchEvent(new CustomEvent(EVT_RESULT, {
        detail: Object.assign({ type: type, at: Date.now() }, payload || {}),
      }));
    } catch (_) {}
  }

  function postProbeEvent(ev) {
    try {
      document.dispatchEvent(new CustomEvent(EVT_PROBE_EVENT, {
        detail: {
          source: ev && ev.source,
          type: ev && ev.type,
          action: ev && ev.action,
          target: ev && ev.target,
          confidence: ev && ev.confidence,
          raw: ev && ev.raw,
          at: Date.now(),
        },
      }));
    } catch (_) {}
  }

  function getPointerTarget() {
    if (!window.MMFusion) return null;
    var ctx = window.MMFusion.getContext();
    return ctx && (ctx.pointerTarget || ctx.gazeTarget);
  }

  async function runClickTargetProbe() {
    if (!window.VoiceExt || !window.VoiceExt.controller) {
      post('click-target', { ok: false, reason: 'VoiceExt.controller not ready' });
      return;
    }
    var target = getPointerTarget();
    if (!target) {
      post('click-target', { ok: false, reason: 'No pointerTarget/gazeTarget in MMFusion context' });
      return;
    }
    try {
      var info = await window.VoiceExt.controller.executeAction('click_target', { target: target });
      post('click-target', { ok: !!(info && info.ok), reason: info && info.reason, target: target });
    } catch (err) {
      post('click-target', { ok: false, reason: err && err.message ? err.message : String(err) });
    }
  }

  async function runTextCommand(text) {
    if (!window.VoiceExt || !window.VoiceExt.controller || !window.VoiceExt.controller.processTextCommand) {
      post('text-command', { ok: false, reason: 'VoiceExt.controller.processTextCommand not ready', text: text });
      return;
    }
    try {
      var info = await window.VoiceExt.controller.processTextCommand(text, 0.99);
      post('text-command', { ok: !!(info && info.ok), reason: info && info.reason, text: text });
    } catch (err) {
      post('text-command', { ok: false, reason: err && err.message ? err.message : String(err), text: text });
    }
  }

  function handleRequest(e) {
    var d = e && e.detail;
    if (!d || !d.type) return;
    if (d.type === 'state') {
      var state = null;
      var context = null;
      try {
        state = window.VoiceExt && window.VoiceExt.controller && window.VoiceExt.controller.getState();
      } catch (_) {}
      try {
        context = window.MMFusion && window.MMFusion.getContext();
      } catch (_) {}
      post('state', { ok: !!state, state: state, fusion: !!window.MMFusion, context: context });
      return;
    }
    if (d.type === 'click-target') {
      runClickTargetProbe();
      return;
    }
    if (d.type === 'text-command') {
      runTextCommand(d.text || '');
    }
  }

  function init() {
    document.addEventListener(EVT_REQUEST, handleRequest);
    if (window.MMFusion) {
      window.MMFusion.subscribe(function (ev) {
        if (ev && ev.source !== 'voice') postProbeEvent(ev);
      });
    }
    post('ready', { ok: true, fusion: !!window.MMFusion });
    console.log('[GesVoiceProbe] isolated-world probe ready');
  }

  init();
})();
