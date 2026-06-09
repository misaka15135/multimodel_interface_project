# 三模融合浏览器扩展 — 架构文档

> **项目背景**：HCI 课程项目，选题为"多模态交互"。三个模态各自可独立交差，融合用于展示多模态协同理念。
>
> **融合范式**：**Point + Speak** — 眼动注视目标、手势选择目标、语音发出命令。源自 Richard Bolt (1980) "Put-That-There" 经典多模态交互理论。

---

## 1. 三模态角色分工

```
┌──────────────────────────────────────────────────────────┐
│                    多模态交互模型                          │
│                                                          │
│   👁️ 眼动 (Eye/Face)     🖐️ 手势 (Gesture)    🎤 语音 (Voice)  │
│   ─────────────────     ─────────────────    ────────────────  │
│   角色：注视 (Focus)      角色：选择 (Selection)  角色：命令 (Command) │
│   提供："用户在看哪"      提供："用户指向哪"      提供："用户要做什么"    │
│   来源：MediaPipe        来源：MediaPipe         来源：Web Speech     │
│        Face Landmarker        Hands                   + DeepSeek LLM │
│                                                          │
│   协同示例：                                              │
│   "盯着点赞按钮" + "说点这个"           = 点击点赞         │
│   "手指向评论区" + "说往下翻"          = 滚动评论区       │
│   "眼看视频区" + "手势指链接" + "说打开它" = 手势目标优先  │
└──────────────────────────────────────────────────────────┘
```

| 模态 | 事件 `type` | 写入共享槽 | 消费共享槽 | 独立性 |
|------|-----------|-----------|-----------|--------|
| 👁️ Eye | `focus` | `gazeTarget` | — | 自动滚动、眨眼点击 |
| 🖐️ Gesture | `selection` / `command` | `pointerTarget` | — | 手势识别→DOM操作 |
| 🎤 Voice | `command` | `lastCommand` | `pointerTarget` ‖ `gazeTarget` | 语音→意图→执行 |

---

## 2. 总体架构

### 2.1 扩展结构一览

```
fusion_v1.0/                               ← Chrome 加载此目录
│
├── manifest.json                           ← 一个清单，管三套模态
│
├── shared/
│   └── mmfusion-bus.js                     ← 融合总线（每个 world 各加载一个实例）
│
├── voice/                                  ← 🎤 语音模态（ISOLATED world）
│   ├── event-bus.js                        #   模块内部事件总线
│   ├── action-registry.js                  #   动作注册表（注册式扩展）
│   ├── intent-matcher.js                   #   本地意图匹配（混合引擎快通道）
│   ├── llm-client.js                       #   DeepSeek API 语义理解（兜底）
│   ├── speech-recognizer.js                #   Web Speech API 语音识别
│   ├── tts-manager.js                      #   TTS 语音合成 + 提示音
│   ├── action-executor.js                  #   内置动作处理器（含 click_target）
│   ├── context-manager.js                  #   上下文记忆 + 撤销栈
│   ├── ui-manager.js                       #   浮动麦克风按钮 + 设置面板
│   ├── voice-controller.js                 #   主脑：混合管线 + 状态机
│   └── voice-content.css                   #   语音 UI 样式
│
├── gesture/                                ← 🖐️ 手势模态（MAIN world）
│   ├── gesture-adapter.js                  #   手势名→规范动作映射 + MMFusion 桥
│   ├── content.js                          #   核心：MediaPipe Hands + 11 手势 + 自由光标
│   └── content.css                         #   手势 UI（状态条 + 动作塔 + 光标）
│
├── eye/                                    ← 👁️ 眼动模态（Service Worker + ISOLATED world）
│   ├── content-script.js                   #   页面注入：十字准星 + 点击/滚动动画
│   ├── service-worker.js                   #   后台：管理 camera + offscreen + 路由消息
│   ├── offscreen.html / offscreen.js       #   MediaPipe 处理宿主（隐藏页面）
│   ├── shared/
│   │   └── gaze-engine.js                  #   Face Landmarker 虹膜定位 + 5 点校准
│   ├── assets/
│   │   └── face_landmarker.task            #   MediaPipe 模型 (~6MB)
│   ├── vendor/mediapipe/
│   │   ├── vision_bundle.mjs               #   MediaPipe JS API
│   │   └── wasm/*.wasm                     #   WASM 运行时
│   ├── app.html / app.js / app.css         #   控制窗口（摄像头预览 + 校准 + 设置）
│   ├── popup.html / popup.js / popup.css   #   工具栏弹窗
│   └── sandbox/                            #   沙箱页面（预留）
│
├── fusion-panel/                           ← 🕹️ 融合控制中心（NEW）
│   ├── popup.html                          #   统一控制面板弹窗
│   ├── popup.js                            #   三模态状态管理
│   └── popup.css                           #   控制面板样式
│
├── FUSION_ARCHITECTURE.md                  ← 本文档
└── FUSION_USAGE.md                         ← 使用说明
```

### 2.2 manifest.json 设计（关键）

```json
{
  "manifest_version": 3,
  "name": "多模态交互浏览器助手",
  "version": "1.0.0",
  "description": "三模融合：眼动注视 + 手势选择 + 语音命令 = point & speak",

  "permissions": [
    "activeTab", "storage", "scripting",
    "tabs", "videoCapture", "offscreen"
  ],
  "host_permissions": ["<all_urls>"],

  "action": {
    "default_popup": "fusion-panel/popup.html",
    "default_title": "多模态助手"
  },

  "background": {
    "service_worker": "eye/service-worker.js"
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "css": ["voice/voice-content.css"],
      "js": [
        "shared/mmfusion-bus.js",
        "voice/event-bus.js",
        "voice/action-registry.js",
        "voice/intent-matcher.js",
        "voice/llm-client.js",
        "voice/speech-recognizer.js",
        "voice/tts-manager.js",
        "voice/action-executor.js",
        "voice/context-manager.js",
        "voice/ui-manager.js",
        "voice/voice-controller.js",
        "eye/content-script.js"
      ],
      "run_at": "document_idle"
    },
    {
      "matches": ["<all_urls>"],
      "css": ["gesture/content.css"],
      "js": [
        "shared/mmfusion-bus.js",
        "gesture/gesture-adapter.js",
        "gesture/content.js"
      ],
      "run_at": "document_idle",
      "world": "MAIN"
    }
  ],

  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  }
}
```

**两个 content_scripts 条目设计原因：**

| 条目 | World | 包含模块 | 必须在此 world 的原因 |
|------|-------|---------|---------------------|
| 条目 1 | ISOLATED (默认) | Voice 全套 + Eye content-script | Voice 需要 `chrome.storage` API（隔离 world 才有）；Eye 同 world 方便后续协作 |
| 条目 2 | MAIN | Gesture adapter + Gesture content.js | Gesture 用 `<script>` 动态加载 MediaPipe CDN，必须访问页面 `window` |

每个 world 各持有一份 `mmfusion-bus.js` 实例。IIFE 开头有幂等守卫 `if (window.MMFusion) return;`，确保同 world 内只初始化一次。

---

## 3. MMFusion 融合总线

### 3.1 为什么用 DOM CustomEvent

```
┌──────────────────────────────────────────────────────┐
│  Chrome 扩展隔离模型                                   │
│                                                      │
│  ┌─ Extension A (voice/eye) ─┐  ┌─ Extension B ────┐ │
│  │ ISOLATED world             │  │ MAIN world        │ │
│  │                            │  │                   │ │
│  │ window.MMFusion  ←── ✗ ──→ │  │ window.MMFusion  │ │
│  │ (隔离，互不可见)            │  │                   │ │
│  │                            │  │                   │ │
│  │ document ─── CustomEvent ─→│←─ document          │ │
│  │ (唯一共享的 DOM)            │  │                   │ │
│  └────────────────────────────┘  └───────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- 不同 Chrome 扩展（或同扩展不同 world）的 `window` **完全隔离**
- 唯一共享的是 **DOM**（`document` 对象）
- MMFusion 用 `document.dispatchEvent(new CustomEvent(...))` 做传输层
- `detail` 被浏览器 structured-clone：**只能传可序列化数据**（不能放活 DOM 元素或函数）
- 每个实例带 `origin` token，收到事件时忽略自己的回声（防自激）

### 3.2 API

```js
// 每个 world 里通过 window.MMFusion 访问（共享同一份代码，各自实例化）

MMFusion.publish(event)           // 发布跨模态事件
MMFusion.subscribe(cb) → unsub   // 订阅所有模态事件
MMFusion.setContext(slot, value)  // 写共享上下文槽（跨 world 镜像）
MMFusion.getContext() → {...}     // 读共享上下文（浅拷贝）
MMFusion.arbitrate(event) → {execute, reason?, winner?}  // 仲裁
```

### 3.3 事件 Schema

```js
{
  source: 'voice' | 'gesture' | 'gaze' | 'face',
  type:   'command' | 'selection' | 'focus' | 'state',
  action: 'scroll_down' | 'click_target' | ... | null,  // snake_case 规范动作名
  params: { ... } | null,
  target: { selector?: string, point?: {x:number, y:number} } | null,
  confidence: 0..1,
  timestamp: number,       // ms
  raw: { ... } | null,     // 模态原始数据
  origin: string,          // 发送方标识（自动）
  seq: number              // 自增序号（自动）
}
```

**规范动作名**（全模态统一）：
`scroll_up/down/to_top/to_bottom`, `refresh`, `go_back/forward`, `zoom_in/out/reset`, `like`, `comment`, `find`, `read_page`, `stop_reading`, `click_target`, `tab_new`, `stop_listening`

### 3.4 共享上下文槽

| 槽名 | 写入方 | 数据类型 | 用途 |
|------|--------|---------|------|
| `gazeTarget` | 👁️ Eye | `{point: {x, y}}` 或 `{selector: '...'}` | 用户正在注视的目标 |
| `pointerTarget` | 🖐️ Gesture | `{point: {x, y}}` 或 `{selector: '...'}` | 手势自由光标指向的目标 |
| `lastCommand` | 🎤 Voice | `{action, params, ...}` | 最近一次执行的命令 |

### 3.5 仲裁策略

- **优先级**：`voice(3) > gesture(2) > gaze(1) > face(0)`
- **去重窗口**：同一规范动作 500ms 内多源只执行一次
- **冲突对**：`scroll_up↔down`、`zoom_in↔out`、`go_back↔forward`（互斥动作按优先级裁决）
- **`_recent` 只收本地 `publish()`** — 远端事件不写入仲裁窗口（避免请求方堵死自己）

---

## 4. 运行时数据流

### 4.1 三模融合主流程

```
页面加载 (bilibili.com)
│
├─ ISOLATED world ─────────────────────────────────────
│
│  shared/mmfusion-bus.js  ←─── CustomEvent ───→  MAIN world
│  │                                                shared/mmfusion-bus.js
│  ├─ voice/event-bus.js                            gesture/gesture-adapter.js
│  ├─ voice/action-registry.js                      gesture/content.js
│  ├─ voice/intent-matcher.js                           │
│  ├─ voice/llm-client.js                           🖐️ MediaPipe Hands
│  ├─ voice/speech-recognizer.js                        │
│  ├─ voice/tts-manager.js                          识别11种手势
│  ├─ voice/action-executor.js                          │
│  ├─ voice/context-manager.js                     publishFusionGesture(gestureName)
│  ├─ voice/ui-manager.js                              │   ↕
│  ├─ voice/voice-controller.js ← 主脑              MMFusion.publish({source:'gesture',
│  │       │                                           │   action:'scroll_down'})
│  │       ├─ processCommand()                         │
│  │       │   ├─ 去重 → 置信度门 → 本地匹配          publishFusionPointer(x, y)
│  │       │   ├─ click_target? → resolveDeicticTarget│   ↕
│  │       │   │   = pointerTarget || gazeTarget     MMFusion.setContext('pointerTarget',
│  │       │   │                                       │   {point:{x,y}})
│  │       │   └─ 仲裁 → 执行 → 反馈                  │
│  │       │                                          │
│  │       └─ publishToFusion() ──────────────────────┘
│  │
│  ├─ eye/content-script.js
│  │       │
│  │       ├─ chrome.runtime.onMessage
│  │       │   ├─ eye-hover → ★ MMFusion.setContext('gazeTarget', {point:{x,y}})
│  │       │   ├─ eye-click → clickAt(x,y)  (眼动自治)
│  │       │   └─ eye-scroll → scrollBy()   (眼动自治)
│  │       │
│  │       └─ 渲染：十字准星 + 标签 + 点击动效
│  │
│  └─ voice/ui-manager.js: 浮动麦克风按钮 (右下角)
│
├─ MAIN world ────────────────────────────────────────
│  gesture/content.js: 摄像头预览 + 手指状态条 + 动作塔
│
└─ Service Worker ────────────────────────────────────
   eye/service-worker.js
   ├─ 管理 offscreen document (camera + MediaPipe)
   ├─ tracker-point → eye-hover → content-script
   └─ 处理 calibrate / settings
```

### 4.2 "Point + Speak" 关键路径

```
用户说"点这个"
  │
  ▼
voice-controller.js: processCommand("点这个")
  │
  ├─ intent-matcher → {action: 'click_target'}
  │
  ├─ resolveDeicticTarget()
  │   │
  │   └─ fusion.getContext()
  │       │
  │       ├─ pointerTarget 存在? → 取手势指向 (优先)
  │       └─ 否则 → 取 gazeTarget (眼动注视回退)
  │
  ├─ elementFromPoint(x, y) 或 querySelector(selector)
  │
  ├─ nearestClickable(el) → <a>/<button>/cursor:pointer
  │
  ├─ simulateClick(el) → el.click() + dispatchEvent(MouseEvent)
  │
  └─ Toast: "已点击 [按钮文字]"
```

### 4.3 仲裁去重路径

```
手势五指下翻 (PALM_DOWN) ──── 200ms 后 ──── 语音"向下滚动"
  │                                              │
  ▼                                              ▼
gesture-adapter.js                          voice-controller.js
  │                                              │
  ▼                                              ▼
MMFusion.publish({                         MMFusion.arbitrate({
  source:'gesture',                          action:'scroll_down',
  action:'scroll_down'                       source:'voice'
})                                          })
  │                                              │
  ├─ _ingest: recent.push({action:'scroll_down', source:'gesture', ts:...})
  │                                              │
  └─────────────────── 500ms 去重窗口 ────────────┤
                                                  ▼
                                          {execute: false, reason: 'dedup', winner: 'gesture'}
                                                  │
                                                  ▼
                                          语音跳过，不重复执行
```

---

## 5. 融合控制中心设计

### 5.1 入口

点击浏览器工具栏的扩展图标，弹出统一控制面板 (`fusion-panel/popup.html`)。

### 5.2 控制面板布局

```
┌─────────────────────────────────────┐
│  🕹️ 多模态助手 — 控制中心            │
│                                     │
│  ┌─ 三模态状态条 ──────────────────┐ │
│  │ 👁️ 眼动  🟢 运行中             │ │
│  │ 🖐️ 手势  🟢 运行中 (自由模式)   │ │
│  │ 🎤 语音  🔵 待机 (等待唤醒词)    │ │
│  └────────────────────────────────┘ │
│                                     │
│  ┌─ 眼动控制 ──────────────────────┐ │
│  │ [启动/停止] [标定]              │ │
│  │ ☑ 指示点  ☑ 眨眼点击  ☐ 驻留   │ │
│  │ ☑ 边缘滚动                      │ │
│  │ 灵敏度: [═══════╪══] 0.68      │ │
│  └────────────────────────────────┘ │
│                                     │
│  ┌─ 手势控制 ──────────────────────┐ │
│  │ 🟢 摄像头运行中                 │ │
│  │ 当前手势: —                     │ │
│  │ [自由交互模式]                  │ │
│  └────────────────────────────────┘ │
│                                     │
│  ┌─ 语音控制 ──────────────────────┐ │
│  │ 状态: 待机 (说"小助手"唤醒)     │ │
│  │ [🎤 开始监听]                  │ │
│  │ ☑ 唤醒词  ☐ TTS反馈           │ │
│  │ API Key: [••••••••] [设置]     │ │
│  └────────────────────────────────┘ │
│                                     │
│  ┌─ 融合状态 ──────────────────────┐ │
│  │ pointerTarget: (328, 512)       │ │
│  │ gazeTarget:    (400, 280)       │ │
│  │ 最后命令: scroll_down (gesture) │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### 5.3 页面浮动指示器

在网页右下角（voice 麦克风按钮上方）增加一个融合状态指示器：

```
┌──────────────────┐
│ 👁️🟢 🖐️🟢 🎤🔵  │  ← 三模状态指示灯（常驻）
└──────────────────┘
```

- 点击展开简易控制面板，可快速启停任一模态
- 颜色：🟢 运行中 / 🔵 待机 / ⚪ 关闭
- 鼠标悬停时显示 tooltip："眼动: 运行 | 手势: 自由模式 | 语音: 唤醒词待机"

---

## 6. 关键技术决策

### 6.1 铁律

1. **跨 world 通信只走 DOM CustomEvent** — `window` 隔离，`chrome.runtime.sendMessage` 仅限扩展内部
2. **跨 world 只传可序列化数据** — `{selector?, point?:{x,y}}`，对端用 `elementFromPoint`/`querySelector` 还原
3. **融合事件带 `origin` token** — 忽略自己回声，防自激
4. **`_recent` 只收本地 `publish()`** — 远端事件不写入仲裁窗口
5. **所有模态命令进统一 `runIntent`** — 享受同一套仲裁/去重/撤销/记录/反馈
6. **click_target 用 `nearestClickable` + `el.click()`** — `elementFromPoint` 返回最内层元素，`dispatchEvent` 不触发浏览器默认行为

### 6.2 独立性保障

每个模态都保留**完全独立运行**的能力：

- 👁️ Eye 断连 → Voice 仍然可以语音命令，Gesture 仍然可以手势控制
- 🖐️ Gesture 关闭 → Voice "点这个"自动回退到 Eye 的 gazeTarget
- 🎤 Voice 休眠 → Eye 和 Gesture 各自独立操作 DOM
- 融合是**增强**而非**依赖**

### 6.3 与 gesvoice_v0.3 的关系

| | gesvoice_v0.3 | fusion_v1.0 |
|---|---|---|
| 定位 | 技术验证版 | 课程演示版 |
| 模态 | Voice + Gesture 模拟器 | Voice + Gesture 真实 + Eye 真实 |
| Eye 接入 | ❌ | ✅ MMFusion setContext |
| Gesture 方式 | JS 模拟器 | MediaPipe Hands 真实摄像头 |
| 控制面板 | 无 | 统一融合控制中心 |
| 演示场景 | 技术自测 | B站实战 |

---

## 7. 眼动模块接入 MMFusion（唯一代码改动）

眼动是三个模块中唯一未接入 MMFusion 的。改动仅需在 `eye/content-script.js` 的 `eye-hover` 处理中加一行：

```js
// eye/content-script.js, chrome.runtime.onMessage 监听内:
if (message.type === "eye-hover") {
    setPointerState(x, y, message.visible !== false);
    // ★ 唯一新增：向融合总线发布注视位置
    if (window.MMFusion) {
        window.MMFusion.setContext('gazeTarget', { point: { x, y } });
    }
    sendResponse({ ok: true });
    return;
}
```

Voice 侧 `voice-controller.js:449` 已有 `c.pointerTarget || c.gazeTarget`，Gesture 侧 `content.js:197-211` 已有 `publishFusionGesture`/`publishFusionPointer`。**其他零改动。**

---

## 8. 模块来源与归属

| 文件/目录 | 来源 | 负责人 | 融合版角色 |
|----------|------|--------|----------|
| `voice/*` | voice v1.0 | 你 | 命令层（ISOLATED world） |
| `gesture/*` | gesture v3.0 | 组长 | 选择层（MAIN world） |
| `eye/*` | face v0.1.0 | 队友 B | 注视层（ISOLATED world + Service Worker） |
| `shared/mmfusion-bus.js` | voice v1.0 提取 | 你 | 融合总线（两个 world 各一实例） |
| `fusion-panel/` | 新建 | 你 | 统一控制中心 |
