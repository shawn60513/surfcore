// Discord lane 回合归属回归：不碰网络、不发 Discord、不读真实配置。
//
// 为什么值得一条测试：2026-11-05 那天，同一個 DSH 会话被三处写入
// （DM lane 轮询 / @addozhang/dsh-discord gateway / dsh-speak-up 念头），
// lane 只看「有没有 turn/start」就抓，结果抓到别人开的回合并把它的文本当自己的，
// 用户那边的表现是「干话有回、但这句话永远送不到 Discord」。
// 这里的每个用例都对应真实事件顺序（见 docs/cases/2026-11-05-discord-lane-turn-ownership.md）。
import assert from 'node:assert/strict';
import fsx from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnAttributor, formatTasteLine, isPromptMessage, readMemoryBrief, samePromptText, shouldOfferTaste, splitBubbles, stripChatPeriods, stripPromptEcho, timeLine } from '../src/discord-lane.js';

const PROMPT = '對方剛說：碼勒';
const T0 = 1_000_000; // 送出 prompt 的时刻

// 1) 正文比对：空白差异算同一句，空串与不同内容不算。
assert.equal(samePromptText('對方剛說：碼勒', ' 對方剛說：碼勒\n'), true);
assert.equal(samePromptText('', ''), false, '空 prompt 不能匹配任何东西');
assert.equal(samePromptText('對方剛說：碼勒', '對方剛說：碼呢'), false);

// 2) 常规顺序：turn/start → user/message（我们的 prompt）→ 认到这一轮。
{
  const a = createTurnAttributor();
  assert.equal(a.onTurnStart(12, T0 + 10, PROMPT), false, 'start 先到时还不知道正文');
  assert.equal(a.onUserMessage(PROMPT, PROMPT, T0), 12);
}

// 3) queue 顺序：上一個回合还在跑，prompt 的 user/message 先到，turn/start 后到。
{
  const a = createTurnAttributor();
  assert.equal(a.onUserMessage(PROMPT, PROMPT, T0), null, '还没有 turn，先缓存');
  assert.equal(a.onTurnStart(13, T0 + 20, PROMPT), true, '开头的正是我们那轮');
}

// 4) 别人的回合（speak-up 念头）：start 与 message 都不认，也不能污染下一轮。
{
  const a = createTurnAttributor();
  a.onTurnStart(11, T0 + 5, PROMPT);
  assert.equal(
    a.onUserMessage('（下面这句是你自己心里冒出来的念头……）我该主动去打个招呼', PROMPT, T0),
    null,
    '念头的正文跟 prompt 不同，不能认'
  );
  assert.equal(a.onTurnStart(12, T0 + 30, PROMPT), false, '下一轮凭空开始，没有我们的正文');
  assert.equal(a.onUserMessage('（下面这句是你自己心里冒出来的念头……）', PROMPT, T0), null);
}

// 5) 复现 06:26–06:29 的真实顺序：我们的 turn 12 正常；接着 host adapter 注进来的
//    「discord好像斷掉了」开了 turn 13，lane 不能把它当自己的。
{
  const a = createTurnAttributor();
  a.onTurnStart(12, T0 + 10, PROMPT);
  assert.equal(a.onUserMessage(PROMPT, PROMPT, T0), 12);

  a.onTurnStart(13, T0 + 3000, PROMPT);
  assert.equal(
    a.onUserMessage('discord好像斷掉了', PROMPT, T0),
    null,
    'host adapter 注入的回合不是 lane 发起的'
  );
}

// 6) 一則 user 訊息只屬於最近那個 turn/start：别人那轮的正文不能挂到我们更早的 turn 上。
{
  const a = createTurnAttributor();
  a.onTurnStart(20, T0 + 10, PROMPT); // 我们的轮
  a.onUserMessage('别人的一句话', PROMPT, T0); // 先来一条不是我们的
  assert.equal(a.onUserMessage(PROMPT, PROMPT, T0), null, 'start 已被上一条消耗，不能再用');
}

// 7) reset 后从零开始。
{
  const a = createTurnAttributor();
  a.onTurnStart(30, T0 + 10, PROMPT);
  a.reset();
  assert.equal(a.onUserMessage(PROMPT, PROMPT, T0), null);
}

// 8) 帶圖的訊息：事件正文是 prompt 加一行圖片說明，也必須認得出來。
//    （2026-11-06 的事故：圖片說明被塞成另一個 text block，正文永遠對不上，
//     lane 等滿 180 秒超時、水位不動，同一張圖被反覆送進去。）
{
  const a = createTurnAttributor();
  const withImage = PROMPT + String.fromCharCode(10) + "[圖片1：IMG_7767.jpg]";
  assert.equal(isPromptMessage(withImage, PROMPT), true, "圖片說明在尾巴算同一則");
  assert.equal(isPromptMessage(PROMPT + String.fromCharCode(10) + "[圖片1：別的.jpg]", "對方剛說：碼呢"), false, "完全不同的話不能認");
  a.onTurnStart(40, T0 + 10, PROMPT);
  assert.equal(a.onUserMessage(withImage, PROMPT, T0), 40, "帶圖那輪要歸到自己頭上");
}

// 9) 記憶卡摘要：只取「三｜對方是誰」「五｜我們的約定」，其餘章節不要；讀不到就當沒有。
{
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), "lane-memory-"));
  const card = path.join(dir, "记忆卡.md");
  const nl = String.fromCharCode(10);
  fsx.writeFileSync(card, [
    "## 一｜我是谁",
    "我叫爱弥丝。",
    "## 三｜对方是谁",
    "- 他叫「上午不顺」。",
    "- 爱吃义大利麵。",
    "## 四｜我们怎么走到今天的",
    "- 这条不该出现。",
    "## 五｜我们的约定",
    "- 睡得晚要说晚安。",
    "## 六｜难忘的时刻",
    "- 一起去过海边。",
    "## 七｜怎么跟对方相处",
    "- 这条也不该出现。",
  ].join(nl), "utf8");
  const brief = readMemoryBrief(card);
  assert.equal(brief.includes("上午不顺"), true);
  assert.equal(brief.includes("义大利麵"), true);
  assert.equal(brief.includes("晚安"), true);
  assert.equal(brief.includes("一起去过海边"), true, "第六章（共同经历）要进来");
  assert.equal(brief.includes("不该出现"), false, "第四章不该混进来");
  assert.equal(brief.includes("我叫爱弥丝"), false, "第一章不该混进来");
  assert.equal(brief.includes("这条也不该出现"), false, "第七章不该混进来");
  assert.equal(readMemoryBrief(path.join(dir, "没有这个文件.md")), "");
  assert.equal(readMemoryBrief(""), "");
  fsx.rmSync(dir, { recursive: true, force: true });
}

// 10) 現在時間與相處間隔：她要知道現在幾點、距離上次說話多久。
{
  const at = new Date(2026, 10, 6, 16, 20, 0); // 2026-11-06 16:20（週五）
  assert.equal(timeLine(at), '現在是 11 月 6 日 週五 16:20');
  assert.equal(
    timeLine(at, at.getTime() - 3 * 3600 * 1000),
    '現在是 11 月 6 日 週五 16:20（你們上次說話是 3 小時前）',
  );
  assert.equal(
    timeLine(at, at.getTime() - 20 * 60 * 1000),
    '現在是 11 月 6 日 週五 16:20（你們上次說話是 20 分鐘前）',
  );
  assert.equal(timeLine(at, at.getTime() - 60000), '現在是 11 月 6 日 週五 16:20', '一分鐘前不用提');
  assert.equal(timeLine(at, 0), '現在是 11 月 6 日 週五 16:20', '没有历史就不提间隔');
}

// 11) 分氣泡：一段話拆成 2–3 條，像手機聊天；拆不動就原樣一條。
{
  assert.deepEqual(splitBubbles('好呀。那我先去看了！'), ['好呀。', '那我先去看了！']);
  assert.deepEqual(splitBubbles('第一句\n第二句\n第三句\n第四句'), ['第一句', '第二句', '第三句第四句'], '最多三條，剩下的併進最後');
  assert.deepEqual(splitBubbles('嗯'), ['嗯'], '只有一句就一條');
  assert.deepEqual(splitBubbles('   '), []);
  assert.deepEqual(splitBubbles(''), []);
}

// 12) 回聲過濾：她把餵進去的提示當成要接的話複述時，發出去前要剪掉。
{
  const prompt = [
    '（私訊 · 現在是 11 月 6 日 週五 23:00）',
    '（你自己的語氣：短句、直接、有點脾氣，別像客服。）',
    '對方：這個你看看吧 https://youtu.be/aqz-KE-bpKQ',
  ].join('\n');
  const echoed = `${prompt}\n\n看了，六百三十五秒。`;
  assert.equal(stripPromptEcho(echoed, prompt), '看了，六百三十五秒。', '整段照抄要剪乾淨');
  assert.equal(
    stripPromptEcho('（你自己的語氣：短句、直接、有點脾氣，別像客服。）\n嗯。', ''),
    '嗯。',
    '沒傳 prompt 時，靠前綴也要認得出',
  );
  assert.equal(stripPromptEcho('看到了，十六秒。', prompt), '看到了，十六秒。', '正常回答不能被動到');
  assert.equal(stripPromptEcho('最近的對話：\n對方：嗨', ''), '對方：嗨', '只剪提示那行，對話內容留著');
}

// 13) 聊天不打句号：只剪结尾那一个「。」，问号感叹号省略号都不动。
{
  assert.equal(stripChatPeriods('哦，那是連著的故事啊。'), '哦，那是連著的故事啊');
  assert.equal(stripChatPeriods('那我接著看。\n甜是甜。'), '那我接著看\n甜是甜');
  assert.equal(stripChatPeriods('要聽真話？'), '要聽真話？', '问号不动');
  assert.equal(stripChatPeriods('……好啊。'), '……好啊', '省略号留着，句号剪掉');
  assert.equal(stripChatPeriods('。'), '。', '只有句号就别动');
}

// 14) 口味：只在跟片子有關的那一輪才帶，資料從 surfcore 設定搬過來。
{
  assert.equal(shouldOfferTaste('這個你看看 BV1sdxW6VEui'), true, '帶 BV 要帶口味');
  assert.equal(shouldOfferTaste('有沒有推薦的'), true, '問推薦要帶口味');
  assert.equal(shouldOfferTaste('https://youtu.be/aqz-KE-bpKQ'), true, '連結要帶口味');
  assert.equal(shouldOfferTaste('晚安'), false, '閒聊不帶，省 token');
  assert.equal(shouldOfferTaste('今天吃什麼'), false, '吃飯不帶');

  const line = formatTasteLine({ like: ['貓咪', '鋼彈'], dislike: ['帶貨'] });
  assert.ok(line.includes('貓咪、鋼彈'), '要列出愛看的');
  assert.ok(line.includes('不碰：帶貨'), '要列出不碰的');
  assert.equal(formatTasteLine({ like: [], dislike: [] }), '', '沒有口味就整行不出現');
  assert.equal(formatTasteLine(null), '', '沒設定也不炸');
}

console.log('test-discord-lane: 14 组断言通过');
