'use strict';

// ============================================================
//  GestureAdapter — 手势模块 → MMFusion 适配桥
// ============================================================
//  这个文件交给「手势模块」的同学使用，不属于语音扩展。
//  作用：把手势检测结果翻译成 MMFusion 标准事件，让语音/眼动等模块感知。
//
//  前置条件：手势扩展（world: MAIN）需要在自己的 manifest 里、在 content.js
//  之前，加载一份 mmfusion-bus.js（与语音扩展共用同一份即可）：
//
//    "content_scripts": [{
//       "matches": ["<all_urls>"],
//       "js": ["mmfusion-bus.js", "gesture-adapter.js", "content.js"],
//       "world": "MAIN"
//    }]
//
//  然后在手势的检测代码里，只需加两类「一行」调用（见文末）。
//  原理：MMFusion 用 document 上的 CustomEvent 跨「隔离 world / MAIN world」通信，
//  所以即便语音和手势是两个独立扩展，也能互通。
// ============================================================

(function () {
  if (!window.MMFusion) {
    console.warn('[GestureAdapter] 未找到 MMFusion，请先加载 mmfusion-bus.js');
    return;
  }

  // 手势名 → 语音侧规范动作名（canonical action）
  // 只映射「跨模态有共同语义」的手势；视频专用手势(播放/快进/倍速)语音侧没有，略过。
  var GESTURE_TO_ACTION = {
    PALM_UP:     'scroll_up',
    PALM_DOWN:   'scroll_down',
    V_SIGN:      'refresh',
    RINGS_UP:    'like',
    POINT_LEFT:  'go_back',
    POINT_RIGHT: 'go_forward',
    // PINKY_ONLY / MIDDLE / HORNS / FREE_MODE_TOGGLE 等为手势模块自身控制/视频操作，
    // 不作为跨模态命令广播（避免误触语音侧动作）。
  };

  /**
   * 发布一条手势命令到融合总线。
   * 在手势「确认触发」的回调里调用，例如 handleContinuous 的 onConfirm 中。
   * @param {string} gestureName 手势名，如 'PALM_UP'
   * @param {number} [confidence] 0..1，缺省 0.9
   */
  window.__mmPublishGesture = function (gestureName, confidence) {
    var action = GESTURE_TO_ACTION[gestureName];
    if (!action) return;
    window.MMFusion.publish({
      source: 'gesture',
      type: 'command',
      action: action,
      confidence: typeof confidence === 'number' ? confidence : 0.9,
      raw: { gesture: gestureName },
    });
  };

  /**
   * 上报「自由模式光标」当前指向的位置（视口坐标），写入共享上下文 pointerTarget。
   * 语音说"点这个/打开它"时会从这里取目标。
   * 建议在 handleFreeModeCursor 里节流调用（如每 100ms 一次）。
   * @param {number} x 视口 X（clientX 语义）
   * @param {number} y 视口 Y（clientY 语义）
   */
  window.__mmPublishPointer = function (x, y) {
    window.MMFusion.setContext('pointerTarget', { point: { x: x, y: y } });
  };

  console.log('[GestureAdapter] 就绪 —— 在手势触发处调用 __mmPublishGesture / __mmPublishPointer');
  // 接入步骤与映射详见 FUSION.md
})();
