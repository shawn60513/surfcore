// Discord lane 回合归属回归：不碰网络、不发 Discord、不读真实配置。
//
// 为什么值得一条测试：2026-11-05 那天，同一個 DSH 会话被三处写入
// （DM lane 轮询 / @addozhang/dsh-discord gateway / dsh-speak-up 念头），
// lane 只看「有没有 turn/start」就抓，结果抓到别人开的回合并把它的文本当自己的，
// 用户那边的表现是「干话有回、但这句话永远送不到 Discord」。
// 这里的每个用例都对应真实事件顺序（见 docs/cases/2026-11-05-discord-lane-turn-ownership.md）。
import assert from 'node:assert/strict';
import { createTurnAttributor, samePromptText } from '../src/discord-lane.js';

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

console.log('test-discord-lane: 7 组断言通过');
