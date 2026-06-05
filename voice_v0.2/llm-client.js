'use strict';

// ============================================================
//  LLMClient — DeepSeek API 语义理解
//  将用户语音文本转化为结构化操作指令
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  const DEEPSEEK_BASE = 'https://api.deepseek.com/v1/chat/completions';
  const MODEL = 'deepseek-chat';

  const SYSTEM_PROMPT = `你是一个浏览器操作助手。根据用户的语音指令，推断用户想要执行什么网页操作。

严格返回以下 JSON 格式之一，不要返回其他内容：
{"action":"scroll_up","amount":300}
{"action":"scroll_down","amount":300}
{"action":"scroll_to_top"}
{"action":"scroll_to_bottom"}
{"action":"refresh"}
{"action":"go_back"}
{"action":"go_forward"}
{"action":"like"}
{"action":"comment","text":"提取出的评论正文"}
{"action":"stop_listening"}
{"action":"none","reason":"无法识别的原因"}

action 说明：
- scroll_up / scroll_down: amount 为滚动像素数，默认 300
- scroll_to_top / scroll_to_bottom: 滚动到页面顶部/底部
- refresh: 刷新当前页面
- go_back / go_forward: 浏览器前进/后退
- like: 用户想点赞，需找到并点击页面中的点赞按钮

---
★ 评论功能 ★
- comment: 用户想对当前页面/帖子发表评论，text 是从用户语音中提取出的评论正文。
  例如用户说"评论太棒了" → {"action":"comment","text":"太棒了"}
  用户说"评论说这个帖子写得真好" → {"action":"comment","text":"这个帖子写得真好"}
  注意 text 只包含评论内容本身，去掉"评论""说""我想说"等引导词。

---
★ 停止监听 ★
- stop_listening: 用户想结束语音控制、停止监听。例如：
  "停止监听" "关闭语音" "别听了" "不用了" "结束" "退下" "休息吧"
  这些都不是 none，必须返回 {"action":"stop_listening"}

---
- none: 无法识别用户意图或不需要操作，需附带 reason`;

  class LLMClient {
    constructor(apiKey) {
      this._apiKey = apiKey || '';
    }

    /** 设置 API Key */
    setApiKey(key) {
      this._apiKey = key;
    }

    /** 是否有 API Key */
    hasApiKey() {
      return !!this._apiKey;
    }

    /**
     * 解析用户语音文本
     * @param {string} transcript — 语音识别结果
     * @returns {Promise<object>} 意图对象 { action, amount?, text?, reason? }
     */
    async interpret(transcript) {
      if (!this._apiKey) {
        throw new Error('未设置 API Key');
      }

      const res = await fetch(DEEPSEEK_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: transcript }
          ],
          temperature: 0.1,
          max_tokens: 200
        })
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API 错误 (${res.status}): ${err}`);
      }

      const data = await res.json();
      const raw = data.choices[0].message.content.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM 返回非 JSON: ' + raw);
      }
      return JSON.parse(jsonMatch[0]);
    }
  }

  exports.llmClient = new LLMClient();
  console.log('[VoiceExt] LLMClient initialized');

})(window.VoiceExt);
