# 多模态融合契约 (MMFusion) — v0.4

> 本文档定义 **语音 / 手势 / 眼动(面部)** 三个模块如何互通，是各模块对接的唯一依据。
> 当前由语音模块(`voice_v0.4`)率先实现并落地；手势、眼动按本契约接入即可。

---

## 1. 角色分工（沿用 `docs/architecture.md`）

| 模态 | 角色 | 事件 `type` | 典型动作 |
|------|------|------------|---------|
| 眼动/面部 | 注视 (focus) | `focus` | 提供"用户在看哪" → 写 `gazeTarget` |
| 手势 | 选择 (selection) | `selection` / `command` | 提供"指向哪" → 写 `pointerTarget`；或直接发命令 |
| 语音 | 命令 (command) | `command` | 发出动作指令；"点这个"时从注视/指向取目标 |

经典融合范式 "**point + speak**"：眼动/手势给**目标**，语音给**动词**。
例：手势光标指向某按钮 + 语音说"点这个" → 点击该按钮。

---

## 2. 为什么用 DOM CustomEvent（关键）

不同 Chrome 扩展的 content script 运行在**隔离的 JS world**，`window` 互不相通：

- 手势扩展是 `"world": "MAIN"`（页面主世界）
- 语音扩展是隔离 world（要用 `chrome.storage`，不能进 MAIN）

二者唯一共享的是 **DOM**。所以融合总线不是一个共享的 `window` 单例，而是
**`document` 上的 CustomEvent**——每个 world 各持一份 `MMFusion` facade（本地订阅 +
上下文缓存），通过 `document.dispatchEvent` 广播跨 world。

**铁律**：跨 world 的事件 `detail` 会被 structured-clone：
- ❌ 不能传活的 DOM 元素 / 函数
- ✅ 只传可序列化的目标描述 `{selector?, point?:{x,y}}`，对端用
  `document.elementFromPoint(point)` / `querySelector(selector)` 还原成活元素
- 每条事件带 `origin` token，自动忽略自己的回声

---

## 3. 事件 schema（上线格式）

```js
{
  source: 'voice' | 'gesture' | 'gaze' | 'face',
  type:   'command' | 'selection' | 'focus' | 'state',
  action: 'scroll_down' | 'click_target' | ... | null,  // snake_case 规范动作名
  params: { ... } | null,
  target: { selector?: string, point?: {x:number, y:number} } | null,
  confidence: 0..1,        // 缺省 1
  timestamp: number,       // ms (Date.now)
  raw: { ... } | null,     // 各模态原始数据（如 {gesture:'PALM_UP'} / {transcript:'...'}）
  origin: string,          // 发送方 world 标识（自动）
  seq: number,             // 自增序号（自动）
}
```

规范动作名（与语音侧一致）：
`scroll_up/down/to_top/to_bottom`、`refresh`、`go_back/forward`、
`zoom_in/out/reset`、`like`、`comment`、`find`、`read_page`、`stop_reading`、
`click_target`、`tab_new`、`stop_listening`。

---

## 4. MMFusion API（`window.MMFusion`，每个 world 各一份）

```js
MMFusion.publish(event)            // 发布事件（自动序列化 + 跨 world 广播）
MMFusion.subscribe(cb) -> unsub    // 订阅所有模态事件（含远端）
MMFusion.setContext(slot, value)   // 设置共享上下文槽（跨 world 镜像）
MMFusion.getContext() -> {...}     // 读取共享上下文（浅拷贝）
MMFusion.arbitrate(event) -> {execute, reason?, winner?}  // 仲裁：此刻是否应执行
MMFusion.dispose()
// 兼容架构文档：MMFusion.init() / MMFusion.onEvent(cb)（= subscribe）
```

**共享上下文槽**：
- `gazeTarget`  —— 眼动写入：`{point:{x,y}}` 或 `{selector}`
- `pointerTarget` —— 手势写入：自由光标指向
- `lastCommand` —— 最近一次命令（可选）

---

## 5. 仲裁策略（多模态同时触发时）

- **优先级**：`voice(3) > gesture(2) > gaze(1) > face(0)`
- **去重窗口**：同一规范动作在 **500ms** 内多源只执行一次
- **冲突对**：`scroll_up↔down`、`zoom_in↔out`、`go_back↔forward` 按优先级裁决

执行方在执行前调用 `arbitrate(ev)`，返回 `{execute:false}` 则跳过。
> v0.4 中**仅语音侧执行**并调用仲裁；手势仍自行执行其 DOM 操作，但其命令事件会进入
> 去重窗口，使紧随的语音重复命令被抑制。手势若想交给统一执行，后续按需接入。

---

## 6. 手势模块接入（3 步，不改你现有逻辑骨架）

1. 在手势扩展 `manifest.json` 的 content.js **之前**加载 `mmfusion-bus.js` 与
   `gesture-adapter.js`（都在 `world: MAIN`）：
   ```json
   "js": ["mmfusion-bus.js", "gesture-adapter.js", "content.js"]
   ```
2. 在手势**确认触发**处加一行（gesture-adapter 已提供全局函数）：
   ```js
   window.__mmPublishGesture("PALM_UP");   // 你检测到的手势名
   ```
3. 在**自由模式光标**移动处加一行（用你已算好的视口坐标，建议节流）：
   ```js
   window.__mmPublishPointer(smoothedCursorX, smoothedCursorY);
   ```

完成后：
- 语音说"向下滚动"会与手势 `PALM_DOWN` 在 500ms 内自动去重
- 语音说"点这个 / 打开它"会点击你光标指向的元素

手势名 → 规范动作映射见 `gesture-adapter.js` 的 `GESTURE_TO_ACTION`。

---

## 7. 眼动/面部模块接入（未来）

只需在估计到注视点后写共享槽：
```js
window.MMFusion.setContext('gazeTarget', { point: { x: gazeX, y: gazeY } });
// 或语义化目标：setContext('gazeTarget', { selector: '#submit-btn' })
```
语音"点这个"在没有手势 `pointerTarget` 时会回退到 `gazeTarget`。
若要发注视事件供他人感知：
```js
window.MMFusion.publish({ source:'gaze', type:'focus', target:{point:{x,y}}, confidence:0.7 });
```

---

## 8. 自测片段

```js
// A. 跨 world 连通性：语音(隔离world)控制台订阅
MMFusion.subscribe(e => console.log('GOT', e.source, e.action));
// 在页面 MAIN world 控制台执行：
MMFusion.publish({ source:'gesture', type:'command', action:'scroll_down' });
// → 语音侧应打印 GOT gesture scroll_down（origin 不同，不会自激）

// B. 指代：MAIN world 设指向，语音说"点这个"
MMFusion.setContext('pointerTarget', { point:{ x:200, y:300 } });
// → 语音 click_target 点击 (200,300) 处元素；未设则提示"没有可操作的目标"

// C. 去重：手势 scroll_down 后 500ms 内语音"向下滚动" → 只滚一次
```

---

## 9. 限制

- DOM 事件**不跨 iframe**：每个 frame 各自一条总线，跨 frame 融合暂不支持。
- 跨 world 目标只认 `selector`/`point`；动态 SPA 中 selector 可能失效，优先用 `point`。
- 坐标须为**视口坐标**（`clientX/clientY` 语义），与 `elementFromPoint` 对齐。
