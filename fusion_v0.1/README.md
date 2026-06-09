# 多模态交互浏览器助手 — fusion_v0.1.0

> **HCI 课程项目** | 三模融合浏览器扩展 | Point + Speak 自然交互范式

---

## 是什么

一个 Chrome 浏览器扩展，整合三种交互模态：

| 模态 | 技术 | 角色 | 独立性 |
|------|------|------|--------|
| 👁️ **眼动** | MediaPipe Face Landmarker | 注视目标 (Focus) | ✅ 自动滚动、眨眼点击 |
| 🖐️ **手势** | MediaPipe Hands | 选择目标 (Selection) | ✅ 11 种手势、自由光标 |
| 🎤 **语音** | Web Speech + DeepSeek LLM | 发出命令 (Command) | ✅ 本地命令 + AI 兜底 |

融合范式：**眼看目标 + 手指目标 + 嘴说命令 = Point & Speak**

---

## 快速开始

1. Chrome → `chrome://extensions/` → 开发者模式 → 加载已解压 → 选 `fusion_v0.1/`
2. 配置 DeepSeek API Key：点扩展图标 → 语音栏 → 齿轮设置 → 填 `sk-...`
3. 打开 bilibili.com 任意视频页面

**启动三模态：**
- 👁️ 眼动：扩展图标 → 控制中心 →「打开控制窗口」→ 启动 → 标定
- 🖐️ 手势：页面左下角「开启增强手势」
- 🎤 语音：说「小助手」唤醒，或点右下角麦克风

**试试说**「点这个」「往下滚」「点赞」「朗读页面」

---

## 架构

详见项目根目录 `FUSION_ARCHITECTURE.md` 和 `FUSION_USAGE.md`。

```
fusion_v0.1/
├── manifest.json              # 一个清单管三套模态
├── shared/mmfusion-bus.js     # 融合总线（DOM CustomEvent 跨 world）
├── voice/                     # 语音模态（ISOLATED world）
├── gesture/                   # 手势模态（MAIN world）
├── eye/                       # 眼动模态（Service Worker + ISOLATED world）
└── fusion-panel/              # 统一控制中心 popup
```

## 版本

v0.1.0 — 初始融合版：三模共存于同一扩展，通过 MMFusion 总线互通。
