import { GazeEngine } from "./shared/gaze-engine.js";

// offscreen.js 运行在隐藏的 offscreen.html 中。
// 它的唯一职责是长期持有摄像头和 MediaPipe 模型，然后把追踪结果发回 service worker。
// 这样控制窗口被最小化或关闭时，追踪仍然可以继续运行。

const video = document.querySelector("#video");
let started = false;

function report(type, payload) {
  // 统一把 GazeEngine 的回调转成 chrome.runtime 消息。
  chrome.runtime.sendMessage({ type, ...payload });
}

const engine = new GazeEngine({
  // 这些回调名对应 service-worker.js 中处理的消息类型。
  onStatus: (text) => report("tracker-status", { text }),
  onFace: (payload) => report("tracker-face", { payload }),
  onMetrics: (metrics) => report("tracker-metrics", { metrics }),
  onPoint: (point) => report("tracker-point", { point }),
  onBlink: (blink) => report("tracker-blink", { blink }),
  onCalibration: (calibration) => report("tracker-calibration", { calibration }),
  onFrame: ({ calibrationTarget }) => report("tracker-frame", { calibrationTarget })
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 只处理 service worker 明确发给 offscreen 的消息，避免误处理其它扩展消息。
  if (message.target !== "offscreen") {
    return false;
  }

  (async () => {
    try {
      if (message.type === "tracker-start") {
        // 第一次启动会请求摄像头、加载模型并进入预测循环；后续启动只更新配置。
        engine.setConfig(message.config || {});
        if (!started) {
          await engine.start(video);
          started = true;
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-config") {
        // 控制面板的滑块、开关变化会实时同步到追踪引擎。
        engine.setConfig(message.config || {});
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-calibrate") {
        // 标定逻辑在 GazeEngine 内部完成，这里只负责触发。
        engine.startCalibration();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-stop") {
        // 停止时释放摄像头 track，方便其它软件重新使用摄像头。
        engine.stop();
        started = false;
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown offscreen message" });
    } catch (error) {
      const text = `启动失败: ${error.name || "Error"} ${error.message || error}`;
      report("tracker-status", { text });
      sendResponse({ ok: false, error: text });
    }
  })();

  return true;
});
