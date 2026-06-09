import { GazeEngine } from "./shared/gaze-engine.js";

const video = document.querySelector("#video");
let started = false;

function report(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload });
}

const engine = new GazeEngine({
  onStatus: (text) => report("tracker-status", { text }),
  onFace: (payload) => report("tracker-face", { payload }),
  onMetrics: (metrics) => report("tracker-metrics", { metrics }),
  onPoint: (point) => report("tracker-point", { point }),
  onBlink: (blink) => report("tracker-blink", { blink }),
  onCalibration: (calibration) => report("tracker-calibration", { calibration }),
  onFrame: ({ calibrationTarget }) => report("tracker-frame", { calibrationTarget })
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") {
    return false;
  }

  (async () => {
    try {
      if (message.type === "tracker-start") {
        engine.setConfig(message.config || {});
        if (!started) {
          await engine.start(video);
          started = true;
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-config") {
        engine.setConfig(message.config || {});
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-calibrate") {
        engine.startCalibration();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "tracker-stop") {
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
