# 🎤 声控助手 Voice Control v0.3

**Chrome 浏览器语音控制扩展 — 唤醒词 + 连续对话 + TTS 反馈**

---

## 📋 功能概览

### 核心特性
- ✅ **唤醒词模式** — 说"小助手"激活，10s 无命令自动休眠
- ✅ **连续对话** — 激活后持续监听，无需反复点击
- ✅ **TTS 语音反馈** — 操作后语音播报确认（可关闭）
- ✅ **DeepSeek LLM 语义理解** — 自然语言→结构化操作
- ✅ **17 种操作** — 覆盖导航、社交、显示、朗读等场景
- ✅ **B站评论直发** — 支持 B站 API + DOM 双路由
- ✅ **多模态融合接口** — 标准事件格式，供手势/眼动模块集成

### 模式说明

| 模式 | 指示灯 | 行为 |
|------|--------|------|
| 待机 (PASSIVE) | 🔵 蓝 | 只检测唤醒词"小助手" |
| 激活 (ACTIVE) | 🟢 绿 | 接收所有语音指令 |
| 关闭 | ⚪ 灰 | 完全不监听 |

---

## 🎮 支持的操作

### 页面导航
| 指令示例 | 动作 |
|---------|------|
| "往下滚动" / "向下滑" | 向下滚动 300px |
| "往上滚" / "回到顶部" | 向上滚动 / 滚到顶部 |
| "刷新页面" | 刷新 |
| "后退" / "前进" | 浏览器前进后退 |

### 显示控制
| 指令示例 | 动作 |
|---------|------|
| "放大" / "字太小了" | 页面放大 10% |
| "缩小" / "字太大了" | 页面缩小 10% |
| "恢复大小" | 恢复 100% 缩放 |
| "朗读页面" / "念给我听" | TTS 朗读页面内容 |
| "别读了" / "闭嘴" | 停止朗读 |

### 实用工具
| 指令示例 | 动作 |
|---------|------|
| "查找人工智能" / "搜索联系方式" | 页面内查找关键词 |
| "新建标签页" | 打开新标签页 |

### 社交互动
| 指令示例 | 动作 |
|---------|------|
| "点赞" | 自动找到并点击页面点赞按钮 |
| "评论太棒了" | 填写评论框 → 提交（B站走API） |

### 系统控制
| 指令示例 | 动作 |
|---------|------|
| "停止监听" / "退下" / "休息吧" | 关闭语音控制 |

---

## 🔧 安装与使用

### 安装
1. Chrome/Edge 打开 `chrome://extensions/`
2. 启用「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `voice_v0.3` 文件夹

### 首次配置
1. 点击右下角 **⚙** 齿轮按钮
2. 输入 DeepSeek API Key（在 [platform.deepseek.com](https://platform.deepseek.com) 获取）
3. （可选）关闭 TTS 语音反馈
4. （可选）关闭唤醒词模式，改为直接监听

### 使用方式

**方式一：唤醒词模式（默认）**
1. 点击右下角麦克风 → 蓝灯亮起
2. 说"**小助手**" → 🔔 叮咚 + 绿灯亮起
3. 说指令如"往下滚动" → 页面滚动 + TTS "好的"
4. 10 秒不说话自动回到蓝灯待机
5. 也可以直接说"小助手往下滚动"一步完成

**方式二：直接模式**
1. 在设置中关闭唤醒词开关
2. 点击麦克风 → 直接说指令

---

## 🏗 架构

```
voice_v0.3/
├── event-bus.js          ① 发布/订阅事件总线（模块间松耦合）
├── action-registry.js    ② 动作注册表（注册式扩展）
├── llm-client.js         ③ DeepSeek API 语义理解
├── speech-recognizer.js  ④ Web Speech API 语音识别
├── tts-manager.js        ⑤ TTS 语音合成 + 提示音
├── action-executor.js    ⑥ 17 个内置动作处理器
├── ui-manager.js         ⑦ UI 组件（按钮/设置/指示灯）
├── voice-controller.js   ⑧ 主脑：唤醒词状态机 + 流程协调
├── voice-content.css     ⑨ 样式表
├── manifest.json         ⑩ 扩展清单
└── README.md             ⑪ 本文档
```

### 关键设计

- **事件驱动**：所有模块通过 `window.VoiceExt.eventBus` 通信，松耦合
- **动作注册制**：新增操作用 `registry.register('name', handler, meta)` 即可
- **状态机**：PASSIVE → (唤醒词) → ACTIVE → (10s超时) → PASSIVE
- **TTS协调**：朗读页面时自动暂停语音识别，读完恢复

### 多模态融合接口

```js
// 1. 外部模块订阅语音事件
window.VoiceExt.controller.onEvent((event) => {
  // event = { source, action, params, confidence, timestamp, raw }
});

// 2. 外部模块触发语音插件动作
await window.VoiceExt.controller.executeAction('scroll_down', { amount: 500 });

// 3. 扩展新动作
window.VoiceExt.actionRegistry.register('screenshot', async (params) => {
  return { ok: true };
}, { description: '截图', icon: '📸', category: 'media' });

// 4. 查状态
window.VoiceExt.controller.getState();
```

---

## ⚙ 技术规格

| 项目 | 说明 |
|------|------|
| 语音识别 | Web Speech API (zh-CN) |
| 语义理解 | DeepSeek `deepseek-chat` |
| TTS | Web Speech Synthesis |
| 唤醒词 | "小助手"（代码可配） |
| 激活超时 | 10 秒 |
| API Key 存储 | `chrome.storage.local`（键名 `voice_ext_apikey`） |

---

## 🚧 已知限制

- 浏览器语音识别在嘈杂环境准确度下降
- `tab_new` 可能被浏览器弹窗拦截器阻止
- Web Speech API 在部分 Chromium 内核浏览器上表现不一
- TTS 朗读长文本时可能被打断

---

## 📝 版本历史

| 版本 | 更新内容 |
|------|---------|
| v0.3.0 | ✨ 唤醒词模式、连续对话、TTS 反馈、+7 动作（缩放/朗读/查找/标签页）、指示灯 UI |
| v0.2.0 | ♻ 模块化重构：EventBus + ActionRegistry + 7 模块拆分、多模态融合接口 |
| v0.1.0 | 🎉 首发：Web Speech + DeepSeek LLM、8 种操作、B站评论 |

---

## 📧 反馈

发现问题？检查控制台（F12）日志。所有模块日志前缀 `[VoiceExt]`。
