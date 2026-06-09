'use strict';

// ============================================================
//  IntentMatcher — 本地意图匹配器
// ============================================================
//  混合意图引擎的「快通道」：常用命令在本地用关键词直接命中，
//  0 延迟、不调 LLM、断网可用。命中不了 / 有歧义才交给 LLM 兜底。
//
//  match(transcript) → { action, ...params, source } | null
//    · null            = 本地无法判定，交给上下文/LLM
//    · source:'local'  = 本地直接命中的动作
//    · source:'context'= 追问/控制类（__followup__ sentinel），交 controller 处理
//
//  规则按 Tier A→D 有序匹配，先匹配先赢，顺序保证「否定/停止」压过「正向词」
//  （如"别读了"必须先于"读"被识别）。
// ============================================================
window.VoiceExt = window.VoiceExt || {};

(function (exports) {

  // ---- 归一化 ----
  function fullToHalf(s) {
    return s.replace(/[！-～]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/　/g, ' ');
  }
  function stripTrailingPunct(s) {
    return s.replace(/[。，！？、~,.!?；;：:\s]+$/g, '');
  }
  function stripFillers(s) {
    return s
      .replace(/^(请|帮我|麻烦你?|我想要?|我要|给我|能不能|帮)/, '')
      .replace(/(谢谢|吧|呢|啊|嘛|哦|喔)$/, '')
      .trim();
  }

  // ---- 关键词表 ----

  // Tier A：停止/否定（必须先于对应正向词）
  const STOP_READING = ['别读了', '别念了', '停止朗读', '别读', '别念', '闭嘴', '不要读', '不用读了'];
  const STOP_LISTENING = ['停止监听', '关闭语音', '别听了', '退下', '休息吧', '关掉语音', '不用听了', '停止监听了'];

  // Tier A：追问/控制（→ __followup__ sentinel）
  const FU_UNDO = ['撤销', '撤回', '返回上一步', '退回去', '撤一下', '回退', '撤销刚才'];
  const FU_REPEAT_LAST = ['重复', '再来一次', '再执行一次', '刚才那个再来', '一样的再来', '再做一次'];
  // 无方向词的"再继续"类（带方向的"再往下"由 Tier D scroll 自然命中）
  const FU_REPEAT_DIR = ['继续', '再来', '再来点', '再多一点', '再多滚', '接着', '接着滚', '再滚一点', '再多点'];
  // confirm/cancel 用「整句精确相等」匹配，避免子串误触（"好的往下滚"不应判为确认）
  const CONFIRM_WORDS = ['是', '是的', '对', '对的', '好', '好的', '可以', '确认', '确定', '嗯', '行', '没错'];
  const CANCEL_WORDS = ['否', '不', '不要', '取消', '算了', '不用', '不是', '不对'];

  // Tier B：指代（需配合动词）
  const DEIXIS_TOKENS = ['这个', '那个', '这里', '那里', '这儿', '那儿', '它', '这', '那'];
  const DEIXIS_VERBS = ['点击', '点', '打开', '选中', '选这个', '选', '激活', '按一下', '按'];

  // Tier C：带参（从原文抽）—— 触发词按「长在前」排，先消费长触发词
  const COMMENT_TRIGGERS = ['评论说', '评价说', '留言说', '发评论', '发个评论', '评论', '评价', '留言'];
  const FIND_TRIGGERS = ['查找', '搜索', '找一下', '找找', '定位到', '找到', '找'];

  // Tier D：简单动词（无参）。每个动作一组关键词，组间不应交叉。
  const SIMPLE = [
    ['scroll_down', ['往下滚', '向下滚', '下滑', '往下', '下翻', '滚下去', '向下']],
    ['scroll_up', ['往上滚', '向上滚', '上滑', '往上', '上翻', '向上']],
    ['scroll_to_top', ['回到顶部', '到顶部', '最上面', '回顶', '顶部']],
    ['scroll_to_bottom', ['到底部', '滚到底', '最下面', '拉到底', '底部']],
    ['refresh', ['刷新', '重新加载', '刷一下']],
    ['go_back', ['后退', '返回', '上一页']],
    ['go_forward', ['前进', '下一页']],
    ['zoom_in', ['放大', '字太小', '大一点', '放大一点']],
    ['zoom_out', ['缩小', '字太大', '小一点', '缩小一点']],
    ['zoom_reset', ['恢复大小', '正常大小', '原始比例', '默认缩放', '恢复缩放']],
    ['read_page', ['朗读', '读一下', '念给我', '读页面', '念一下', '读给我']],
    ['like', ['点赞', '赞一下', '给个赞']],
    ['tab_new', ['新建标签', '新标签页', '打开新页面', '新建页面']],
  ];

  function includesAny(text, list) {
    for (let i = 0; i < list.length; i++) {
      if (text.indexOf(list[i]) >= 0) return list[i];
    }
    return null;
  }

  /** 在 text 中找到第一个触发词，返回其后内容 { trigger, rest } | null */
  function extractAfter(text, triggers) {
    let best = null;
    for (let i = 0; i < triggers.length; i++) {
      const idx = text.indexOf(triggers[i]);
      if (idx >= 0 && (!best || idx < best.idx)) {
        best = { idx, trigger: triggers[i] };
      }
    }
    if (!best) return null;
    return { trigger: best.trigger, rest: text.slice(best.idx + best.trigger.length) };
  }

  function cleanParam(s) {
    return s
      .replace(/^(说|一下|一点|到|了|的|下|：|:)+/, '')
      .replace(/["'""'']/g, '')
      .trim();
  }

  class IntentMatcher {
    /**
     * @param {string} transcript
     * @returns {object|null}
     */
    match(transcript) {
      if (!transcript) return null;

      const cleaned = fullToHalf(transcript).replace(/\s+/g, '');         // 抽参用（保留内容）
      const raw = stripTrailingPunct(cleaned);
      const norm = stripFillers(raw).toLowerCase();                        // 匹配用
      if (!norm) return null;

      // ===== Tier A：停止/否定 =====
      if (includesAny(norm, STOP_READING)) return { action: 'stop_reading', source: 'local' };
      if (includesAny(norm, STOP_LISTENING)) return { action: 'stop_listening', source: 'local' };

      // ===== Tier A：追问/控制 =====
      if (includesAny(norm, FU_UNDO)) return { action: '__followup__', kind: 'undo', source: 'context' };
      if (includesAny(norm, FU_REPEAT_LAST)) return { action: '__followup__', kind: 'repeat_last', source: 'context' };
      if (includesAny(norm, FU_REPEAT_DIR)) return { action: '__followup__', kind: 'repeat_dir', source: 'context' };
      // confirm/cancel：整句精确相等，避免误触
      if (CONFIRM_WORDS.indexOf(norm) >= 0) return { action: '__followup__', kind: 'confirm', source: 'context' };
      if (CANCEL_WORDS.indexOf(norm) >= 0) return { action: '__followup__', kind: 'cancel', source: 'context' };

      // ===== Tier B：指代（需 指代词 + 动词）=====
      if (includesAny(norm, DEIXIS_TOKENS) && includesAny(norm, DEIXIS_VERBS)) {
        return { action: 'click_target', source: 'local' };
      }

      // ===== Tier C：带参（find / comment），抽到非空内容即短路 =====
      const cm = extractAfter(cleaned, COMMENT_TRIGGERS);
      if (cm) {
        const text = cleanParam(cm.rest);
        if (text) return { action: 'comment', text: text, source: 'local' };
      }
      const fd = extractAfter(cleaned, FIND_TRIGGERS);
      if (fd) {
        const text = cleanParam(fd.rest);
        if (text) return { action: 'find', text: text, source: 'local' };
      }

      // ===== Tier D：简单动词，≥2 个不同动作命中视为歧义 → null（落 LLM）=====
      const hits = [];
      for (let i = 0; i < SIMPLE.length; i++) {
        if (includesAny(norm, SIMPLE[i][1])) hits.push(SIMPLE[i][0]);
      }
      if (hits.length === 1) return { action: hits[0], source: 'local' };

      // 多命中（歧义）或零命中 → 交给 LLM
      return null;
    }
  }

  exports.intentMatcher = new IntentMatcher();
  console.log('[VoiceExt] IntentMatcher initialized');

})(window.VoiceExt);
