'use strict';

// Runs in MAIN world. This is a no-camera gesture simulator for fusion testing:
// it publishes gesture commands, writes pointerTarget, and asks the isolated
// voice-side probe to execute click_target against that target.
(function () {
  if (window.__gesvoiceSimulatorLoaded) return;
  window.__gesvoiceSimulatorLoaded = true;

  var EVT_RESULT = 'gesvoice:test-result';
  var EVT_REQUEST = 'gesvoice:test-request';
  var EVT_PROBE_EVENT = 'gesvoice:probe-event';
  var root = null;
  var pointer = null;
  var logEl = null;
  var origin = 'gesvoice-sim-' + Math.random().toString(36).slice(2);
  var seq = 0;
  var gestureToAction = {
    PALM_UP: 'scroll_up',
    PALM_DOWN: 'scroll_down',
    V_SIGN: 'refresh',
    RINGS_UP: 'like',
    POINT_LEFT: 'go_back',
    POINT_RIGHT: 'go_forward',
  };
  var status = {
    ready: false,
    voiceEvent: false,
    pointer: false,
    click: false,
  };

  function byId(id) { return root && root.querySelector('[data-id="' + id + '"]'); }

  function log(msg, tone) {
    if (!logEl) return;
    var row = document.createElement('div');
    row.className = 'gesvoice-log-row ' + (tone || '');
    row.textContent = new Date().toLocaleTimeString() + '  ' + msg;
    logEl.prepend(row);
    while (logEl.children.length > 8) logEl.removeChild(logEl.lastChild);
  }

  function setBadge(id, ok, text) {
    var el = byId(id);
    if (!el) return;
    el.textContent = text || (ok ? 'PASS' : 'WAIT');
    el.className = 'gesvoice-badge ' + (ok ? 'pass' : 'wait');
  }

  function updateStatus() {
    setBadge('badge-ready', status.ready, status.ready ? 'READY' : 'WAIT');
    setBadge('badge-event', status.voiceEvent, status.voiceEvent ? 'PASS' : 'WAIT');
    setBadge('badge-pointer', status.pointer, status.pointer ? 'PASS' : 'WAIT');
    setBadge('badge-click', status.click, status.click ? 'PASS' : 'WAIT');
  }

  function dispatchRequest(type, payload) {
    document.dispatchEvent(new CustomEvent(EVT_REQUEST, {
      detail: Object.assign({ type: type, at: Date.now() }, payload || {}),
    }));
  }

  function dispatchFusionEvent(detail) {
    document.dispatchEvent(new CustomEvent('mmfusion:event', { detail: detail }));
  }

  function dispatchFusionContext(slot, value) {
    document.dispatchEvent(new CustomEvent('mmfusion:context', {
      detail: { slot: slot, value: value, origin: origin },
    }));
  }

  function publishGesture(name) {
    if (typeof window.__mmPublishGesture === 'function') {
      window.__mmPublishGesture(name, 0.98);
      log('published gesture: ' + name, 'good');
      return;
    }

    var action = gestureToAction[name];
    if (!action) {
      log('gesture has no fusion action: ' + name, 'bad');
      return;
    }

    dispatchFusionEvent({
      source: 'gesture',
      type: 'command',
      action: action,
      params: null,
      target: null,
      confidence: 0.98,
      timestamp: Date.now(),
      raw: { gesture: name, fallback: true },
      origin: origin,
      seq: seq++,
    });
    log('published gesture fallback: ' + name + ' -> ' + action, 'good');
  }

  function movePointerToElement(el) {
    if (!el) {
      log('Pointer publish failed: no target element', 'bad');
      return null;
    }
    var rect = el.getBoundingClientRect();
    var x = Math.round(rect.left + rect.width / 2);
    var y = Math.round(rect.top + rect.height / 2);
    if (typeof window.__mmPublishPointer === 'function') {
      window.__mmPublishPointer(x, y);
    } else {
      dispatchFusionContext('pointerTarget', { point: { x: x, y: y } });
    }
    pointer.style.left = x + 'px';
    pointer.style.top = y + 'px';
    pointer.classList.add('show');
    status.pointer = true;
    updateStatus();
    log('pointerTarget set' + (typeof window.__mmPublishPointer === 'function' ? '' : ' fallback') + ': (' + x + ', ' + y + ')', 'good');
    return { x: x, y: y };
  }

  function ensureClickTarget() {
    var target = document.getElementById('gesvoice-click-target');
    if (target) return target;

    target = document.createElement('button');
    target.id = 'gesvoice-click-target';
    target.type = 'button';
    target.textContent = 'Click Probe';
    target.addEventListener('click', function () {
      status.click = true;
      updateStatus();
      target.classList.add('hit');
      setTimeout(function () { target.classList.remove('hit'); }, 800);
      log('voice executor clicked probe target', 'good');
    });
    document.body.appendChild(target);
    return target;
  }

  function runSmokeTest() {
    status.voiceEvent = false;
    status.pointer = false;
    status.click = false;
    updateStatus();
    log('smoke test started');

    publishGesture('PALM_DOWN');
    setTimeout(function () {
      movePointerToElement(ensureClickTarget());
    }, 250);
    setTimeout(function () {
      dispatchRequest('text-command', { text: '点这个' });
      log('submitted silent voice command: 点这个');
    }, 550);
    setTimeout(function () {
      if (status.voiceEvent && status.pointer && status.click) log('smoke test PASS', 'good');
      else log('smoke test incomplete: event=' + status.voiceEvent + ', pointer=' + status.pointer + ', click=' + status.click, 'bad');
    }, 1200);
  }

  function buildUI() {
    if (document.getElementById('gesvoice-simulator-root')) return;
    root = document.createElement('div');
    root.id = 'gesvoice-simulator-root';
    root.innerHTML = [
      '<div class="gesvoice-head">',
      '  <strong>GesVoice v0.2</strong>',
      '  <button type="button" data-action="collapse" title="收起/展开">-</button>',
      '</div>',
      '<div class="gesvoice-body">',
      '  <div class="gesvoice-grid">',
      '    <button type="button" data-gesture="PALM_UP">上滚</button>',
      '    <button type="button" data-gesture="PALM_DOWN">下滚</button>',
      '    <button type="button" data-gesture="POINT_LEFT">后退</button>',
      '    <button type="button" data-gesture="POINT_RIGHT">前进</button>',
      '    <button type="button" data-gesture="RINGS_UP">点赞</button>',
      '    <button type="button" data-gesture="V_SIGN">刷新</button>',
      '  </div>',
      '  <div class="gesvoice-actions">',
      '    <button type="button" data-action="target">设置指针</button>',
      '    <button type="button" data-action="click">探针点击</button>',
      '    <button type="button" data-action="smoke">自动测试</button>',
      '    <button type="button" data-action="state">状态</button>',
      '  </div>',
      '  <form class="gesvoice-command" data-id="command-form">',
      '    <input data-id="command-input" value="点这个" aria-label="静音语音命令">',
      '    <button type="submit">文本语音</button>',
      '  </form>',
      '  <div class="gesvoice-status">',
      '    <span>Probe <b data-id="badge-ready" class="gesvoice-badge wait">WAIT</b></span>',
      '    <span>Event <b data-id="badge-event" class="gesvoice-badge wait">WAIT</b></span>',
      '    <span>Pointer <b data-id="badge-pointer" class="gesvoice-badge wait">WAIT</b></span>',
      '    <span>Click <b data-id="badge-click" class="gesvoice-badge wait">WAIT</b></span>',
      '  </div>',
      '  <div class="gesvoice-log" data-id="log"></div>',
      '</div>',
    ].join('');
    document.body.appendChild(root);
    logEl = byId('log');

    pointer = document.createElement('div');
    pointer.id = 'gesvoice-pointer';
    document.body.appendChild(pointer);

    root.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest('button');
      if (!btn) return;
      var gesture = btn.getAttribute('data-gesture');
      var action = btn.getAttribute('data-action');
      if (gesture) publishGesture(gesture);
      if (action === 'target') movePointerToElement(ensureClickTarget());
      if (action === 'click') dispatchRequest('click-target');
      if (action === 'smoke') runSmokeTest();
      if (action === 'state') dispatchRequest('state');
      if (action === 'collapse') root.classList.toggle('collapsed');
    });

    byId('command-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = byId('command-input');
      var text = input && input.value ? input.value.trim() : '';
      if (!text) return;
      dispatchRequest('text-command', { text: text });
      log('submitted silent voice command: ' + text);
    });

    document.addEventListener(EVT_RESULT, function (e) {
      var d = e.detail || {};
      if (d.type === 'ready') {
        status.ready = !!d.ok;
        updateStatus();
        log('isolated probe ready, fusion=' + d.fusion, d.ok ? 'good' : 'bad');
      } else if (d.type === 'click-target') {
        if (d.ok) status.click = true;
        updateStatus();
        log('click_target result: ' + (d.ok ? 'ok' : 'fail') + (d.reason ? ' - ' + d.reason : ''), d.ok ? 'good' : 'bad');
      } else if (d.type === 'text-command') {
        log('text command result: ' + (d.ok ? 'ok' : 'fail') + ' "' + (d.text || '') + '"' + (d.reason ? ' - ' + d.reason : ''), d.ok ? 'good' : 'bad');
      } else if (d.type === 'state') {
        log('voice state: ' + JSON.stringify({ state: d.state, context: d.context, fusion: d.fusion }));
      }
    });

    document.addEventListener(EVT_PROBE_EVENT, function (e) {
      var d = e.detail || {};
      if (d.source === 'gesture') {
        status.voiceEvent = true;
        updateStatus();
        log('isolated voice side saw gesture: ' + d.action, 'good');
      }
    });

    setTimeout(function () { dispatchRequest('state'); }, 300);
    log('simulator ready, adapter=' + (typeof window.__mmPublishGesture === 'function' ? 'ready' : 'fallback'));
    updateStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})();
