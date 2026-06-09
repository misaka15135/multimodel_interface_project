'use strict';

// ============================================================
//  LLMClient — DeepSeek API 语义理解
//  将用户语音文本转化为结构化操作指令；本地匹配器命中不了时才调用
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  const DEEPSEEK_BASE = 'https://api.deepseek.com/v1/chat/completions';
  const MODEL = 'deepseek-v4-flash';

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
{"action":"zoom_in"}
{"action":"zoom_out"}
{"action":"zoom_reset"}
{"action":"read_page"}
{"action":"stop_reading"}
{"action":"find","text":"要查找的关键词"}
{"action":"click_target"}
{"action":"tab_new"}
{"action":"stop_listening"}
{"action":"none","reason":"无法识别的原因"}

action 说明：

■ 页面操作：
- scroll_up / scroll_down: amount 为滚动像素数，默认 300
- scroll_to_top / scroll_to_bottom: 滚动到页面顶部/底部
- refresh: 刷新当前页面
- go_back / go_forward: 浏览器前进/后退

■ 缩放：
- zoom_in: 放大页面，如"放大""放大一点""字太小了"
- zoom_out: 缩小页面，如"缩小""缩小一点""字太大了"
- zoom_reset: 恢复默认缩放，如"恢复大小""正常大小""原始比例"

■ 朗读：
- read_page: 用户想听页面内容，如"读一下""朗读页面""念给我听"
- stop_reading: 停止朗读，如"别读了""停下""闭嘴""别念了" — 这些都不是 none！

■ 查找：
- find: 在当前页面搜索文字，text 为搜索关键词。
  如"查找人工智能" → {"action":"find","text":"人工智能"}
  "搜索一下联系方式" → {"action":"find","text":"联系方式"}

■ 指代点击（多模态）：
- click_target: 用户用指代词指向某个目标并要点击，如"点这个""打开它""选中那个""激活这个"。
  目标位置由手势/眼动模块提供，你只需返回 {"action":"click_target"}。

■ 标签页：
- tab_new: 打开新标签页，如"新建标签""打开新页面"

■ 社交互动：
- like: 用户想点赞，需找到并点击页面中的点赞按钮

■ 评论功能：
- comment: 用户想对当前页面/帖子发表评论，text 是从用户语音中提取出的评论正文。
  如"评论太棒了" → {"action":"comment","text":"太棒了"}
  "评论说写得真好" → {"action":"comment","text":"写得真好"}
  text 只包含评论内容，去掉"评论""说"等引导词。

■ 停止监听：
- stop_listening: 用户想结束语音控制，如"停止监听""关闭语音""别听了""退下""休息吧"
  这些都不是 none，必须返回 {"action":"stop_listening"}

■ 忽略：
- none: 无法识别或不需要操作，需附带 reason`;

  class LLMClient {
    constructor(apiKey) {
      this._apiKey = apiKey || '';
    }

    setApiKey(key) { this._apiKey = key; }
    hasApiKey() { return !!this._apiKey; }

    async interpret(transcript) {
      if (!this._apiKey) throw new Error('未设置 API Key');

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
      if (!jsonMatch) throw new Error('LLM 返回非 JSON: ' + raw);
      return JSON.parse(jsonMatch[0]);
    }
  }

  exports.llmClient = new LLMClient();
  console.log('[VoiceExt] LLMClient initialized');

})(window.VoiceExt);
