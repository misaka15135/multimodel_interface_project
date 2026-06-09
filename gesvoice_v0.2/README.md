# GesVoice Fusion Test v0.2

这是一个无摄像头、无需出声也能跑的语音 + 手势融合测试扩展。

## 目的

- 验证 MAIN world 的手势侧能通过 `MMFusion` 发事件给 isolated world 的语音侧。
- 验证手势侧写入 `pointerTarget` 后，语音执行器可以执行 `click_target`。
- 在真实摄像头和麦克风不可用时，用页面左下角的模拟器先测融合链路。
- 用“文本语音”输入框把打字内容送进语音侧真实意图管线，例如 `点这个`。

## 使用

1. Chrome/Edge 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 加载已解压扩展，选择 `gesvoice_v0.2` 文件夹。
4. 打开任意普通网页。
5. 用左下角 `GesVoice v0.2` 面板点击“自动测试”。

看到面板里的 `Probe / Event / Pointer / Click` 都变成通过，就说明跨 world 融合链路已经跑通。

## 面板按钮

- `上滚/下滚/后退/前进/点赞/刷新`：模拟手势命令，走 `window.__mmPublishGesture(...)`。
- `设置指针`：创建页面中央测试按钮，并把 `pointerTarget` 写入 `MMFusion`。
- `语音侧点击`：请求 isolated world 的语音侧探针执行 `click_target`。
- `文本语音`：把输入框里的文字当作语音识别结果处理。
- `自动测试`：依次模拟手势事件、设置指针、提交文本语音 `点这个`。
- `状态`：读取 `VoiceExt.controller.getState()`。

## 说明

这个版本不加载真实手势摄像头逻辑，只保留手势适配接口和模拟器。后续摄像头恢复后，可以把 `gesture_control_extension_version5/content.js` 接入同一套 `gesture-adapter.js` 调用点。
