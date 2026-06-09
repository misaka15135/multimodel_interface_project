# GesVoice Fusion Test v0.3 — 统一执行路径

语音 + 手势双模融合测试版。**核心变化 (v0.3)**：手势命令不再"只发不收"，而是通过 MMFusion 送入 voice 侧的 `runIntent` 管线，与语音命令走**同一套仲裁/去重/撤销/上下文记录/反馈**。

## 与 v0.2 的关键区别

| | v0.2 | v0.3 |
|---|------|------|
| 手势命令 | 发 MMFusion 事件 → voice 侧只 console.log | 发 MMFusion 事件 → voice 侧 `handleExternalCommand` → `runIntent` 执行 |
| 仲裁 | 只有语音调 `arbitrate`，手势独立滚 | 手势和语音都过 `arbitrate`，500ms 内同动作互斥 |
| 去重 | 单向（语音抑制语音） | 双向（语音 ↔ 手势互相抑制） |
| 撤销 | 只有语音操作可撤销 | 手势触发的操作也可撤销（走同一 undo 栈） |
| `_recent` 写入时机 | `publish()` + `_onDomEvent` 双入口 | 仅 `publish()` 写入，远端事件不污染 |

## 统一执行流

```
手势(MAIN) → MMFusion.publish ──DOM CustomEvent──→ voice侧收到
                                                       ↓
语音 → processCommand ─→ runIntent → arbitrate → execute → record → publishToFusion → 反馈
                                                       ↑
                                           handleExternalCommand(ev)
```

## 使用

1. Chrome/Edge 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 加载已解压扩展，选择 `gesvoice_v0.3` 文件夹。
4. 打开任意普通网页 — 左下角出现 `GesVoice v0.3` 面板。
5. 点击"自动测试"：会依次发手势命令 → 设指针 → 文本语音"点这个"，**所有手势命令真实执行**（不只是探针检测事件连通性）。

面板里的 `Probe / Event / Pointer / Click` 全部 PASS = 融合链路 + 统一执行均正常。

## 面板按钮

- `上滚/下滚/后退/前进/点赞/刷新` → 模拟手势命令 → voice 侧通过 `runIntent`**真实执行**滚动/导航/点赞等
- `设置指针` → 创建页面中央测试按钮，写入 `pointerTarget`
- `探针点击` → 请求 isolated world 探针执行 `click_target`（走 `executeAction` API）
- `文本语音` → 把输入框文字送入 `processCommand` 管线（本地匹配 + LLM 兜底）
- `自动测试` → 以上步骤自动化顺序执行
- `状态` → 读取 `getState()`

## 技术细节

### mmfusion-bus.js 变更

移除 `_onDomEvent` 中的 `_ingest` 调用：远端 publish 是"请求执行"不是"已执行"，不应写入仲裁窗口 `_recent`。只有本地 `publish()`（voice 执行后调用的 `publishToFusion`）才写入。这样：
- 手势 publish 不会堵死自己的执行（自身不在 `_recent` 中）
- voice 执行后在 `_recent` 留痕，后续任何模态的同类命令 500ms 内被去重
- 优先级冲突只发生在已执行命令之间

### voice-controller.js 变更

- 新增 `handleExternalCommand(ev)` — 把 MMFusion 外部事件转化为 intent，进 `runIntent`
- `runIntent` 仲裁 source 从硬编码 `'voice'` 改为 `intent.source || 'voice'`
- `publishToFusion` 的 `raw` 增加 `executedFor` 字段标记实际请求方
- `SOURCE_TAG` 增加 `gesture: '✋手势'`、`gaze: '👁注视'`

## 说明

不加载真实手势摄像头逻辑，只保留手势适配接口和模拟器。后续摄像头恢复后，把 `gesture_control_extension_version5/content.js` 接入同一套 `gesture-adapter.js` 即可。
