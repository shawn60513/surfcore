// 记忆读写回归：不碰网络、不碰真实档案（全在临时目录）。
//
// 事故背景：lane 只会「读」记忆卡摘要，她说的话永远写不回去；
// 后来决定「日记自动记 + 每晚她自己挑重点」，这里守住写档那一段别写坏格式。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCardEntries, appendDiary, buildConsolidatePrompt, clockStamp, dayStamp, foreignBindings, memoryLayout, parseConsolidate, parseConsolidateExtra, pruneForeignBindings, readDiary, readRecentDiary, shouldConsolidate, pinFishMemoryOff } from '../src/lane-memory.js';

const nl = String.fromCharCode(10);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-memory-'));
const card = path.join(dir, '记忆卡.md');

fs.writeFileSync(card, [
  '# 档案',
  '',
  '## 一｜我是谁',
  '',
  '我叫爱弥丝。',
  '',
  '## 三｜对方是谁',
  '- 他喜欢猫。',
  '',
  '## 五｜我们的约定',
  '- 说晚安。',
  '',
  '## 六｜难忘的时刻',
  '- 第一次说早安。',
  '',
].join(nl), 'utf8');

const layout = memoryLayout(card);
assert.equal(memoryLayout(''), null, '空路径 = 没有记忆');
assert.equal(layout.diaryDir, path.join(dir, '日记'));

// 1) 日期/时间格式
const at = new Date(2026, 10, 6, 9, 5, 7);
assert.equal(dayStamp(at), '2026-11-06');
assert.equal(clockStamp(at), '09:05');

// 2) 日记：第一次写要有标题，之后追加；没有内容的轮次不写
const diary = appendDiary(layout, { at, user: '今天好累', assistant: '那就早点睡。' });
assert.equal(diary, path.join(dir, '日记', '2026-11-06.md'));
assert.equal(fs.existsSync(diary), true);
assert.equal(readDiary(layout, '2026-11-06').startsWith('【2026-11-06】'), true);
appendDiary(layout, { at, user: '吃了吗', assistant: '吃了。' });
const body = readDiary(layout, '2026-11-06');
assert.equal(body.includes('他：今天好累 → 我：那就早点睡。'), true);
assert.equal(body.includes('他：吃了吗 → 我：吃了。'), true);
assert.equal(appendDiary(layout, { at, user: '', assistant: '' }), '', '空对话不写');
assert.equal(readDiary(layout, '2026-01-01'), '', '没有那天的日记返回空串');

// 3) 整理提示词要带上当天日记，且要求「章号|内容」
const prompt = buildConsolidatePrompt(body);
assert.equal(prompt.includes('2026-11-06'), true);
assert.equal(prompt.includes('三（他是誰'), true);
assert.equal(prompt.includes('只回一個字：沒有'), true);

// 4) 解析：只认允许的章，杂行丢掉
const parsed = parseConsolidate([
  '三|他养了六只猫',
  '五｜周末去看猫展',
  '六|第一次一起看电影',
  '七|不该收的章',
  '随便说两句',
  '',
].join(nl));
assert.deepEqual(parsed, [
  { chapter: '三', text: '他养了六只猫' },
  { chapter: '五', text: '周末去看猫展' },
  { chapter: '六', text: '第一次一起看电影' },
]);

// 5) 写入记忆卡：插在对应章末尾（下一章标题之前），并留备份
const res = appendCardEntries(card, parsed, at);
assert.equal(res.added, 3);
assert.equal(fs.existsSync(res.backup), true, '写之前必须有备份');
const after = fs.readFileSync(card, 'utf8');
const lines = after.split(nl);
const iThree = lines.indexOf('## 三｜对方是谁');
const iFive = lines.indexOf('## 五｜我们的约定');
const iSix = lines.indexOf('## 六｜难忘的时刻');
const iCat = lines.indexOf('- 他养了六只猫');
const iShow = lines.indexOf('- 周末去看猫展');
assert.equal(lines[iThree + 1], '- 他喜欢猫。');
assert.equal(iCat > iThree && iCat < iFive, true, '三章的新条目要在三章里、五章之前');
assert.equal(iShow > iFive && iShow < iSix, true, '五章的新条目要在五章里、六章之前');
assert.equal(after.includes('## 七'), false, '不许新开章');

// 6) 空条目 / 未知章：一个都不写，也不产生备份
const before = fs.readFileSync(card, 'utf8');
const none = appendCardEntries(card, [{ chapter: '七', text: '坏章' }], at);
assert.equal(none.added, 0);
assert.equal(none.backup, '');
assert.equal(fs.readFileSync(card, 'utf8'), before);

// 7) 每天只整理一次，且要在设定的小时之后
const eight = new Date(2026, 10, 6, 8, 0, 0);
const late = new Date(2026, 10, 6, 23, 10, 0);
assert.equal(shouldConsolidate({ lastConsolidated: '' }, { hour: 23, now: eight }), false);
assert.equal(shouldConsolidate({ lastConsolidated: '' }, { hour: 23, now: late }), true);
assert.equal(shouldConsolidate({ lastConsolidated: '2026-11-06' }, { hour: 23, now: late }), false);
assert.equal(shouldConsolidate({ lastConsolidated: '2026-11-05' }, { hour: 23, now: late }), true);
assert.equal(shouldConsolidate({ lastConsolidated: '' }, { hour: -1, now: late }), false, 'hour < 0 = 关掉');

// 8) 星汐绑定里混进来的外来会话要能被认出来（拾星会把它们也整理进档案）
const folder = 'C:/Users/USER/.dsh/xingxi/会话/爱弥丝';
const bindings = {
  'session-ef58a582': 'C:/Users/USER/.dsh/xingxi/会话/爱弥丝/',
  'session-fa913906': 'C:\\Users\\USER\\.dsh\\xingxi\\会话\\爱弥丝',
  'e03922e8-8f4c': 'C:/Users/USER/.dsh/xingxi/会话/爱弥丝',
  'other-session': 'C:/Users/USER/.dsh/xingxi/会话/别人',
};
assert.deepEqual(
  foreignBindings(bindings, { folder, sessionId: 'session-ef58a582', workers: ['session-fa913906'] }),
  ['e03922e8-8f4c'],
  '自己人（lane + 拾星工人）不算，别的档案也不算',
);
assert.deepEqual(foreignBindings(null, { folder }), []);
assert.deepEqual(foreignBindings(bindings, { folder: '', sessionId: 'x' }), [], '没给档案目录就什么都不算');

// 9) 真去改星汐 config：混进来的会话被摘掉，自己人和别的档案原样留着，且留备份
const cfgFile = path.join(dir, 'xingxi-config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ 绑定: {
  'session-ef58a582': folder,
  'session-fa913906': folder,
  'e03922e8-8f4c': folder,
  'other-session': 'C:/Users/USER/.dsh/xingxi/会话/别人',
} }, null, 2), 'utf8');
const pruned = pruneForeignBindings(cfgFile, { folder, sessionId: 'session-ef58a582', workers: ['session-fa913906'] });
assert.deepEqual(pruned.removed, ['e03922e8-8f4c']);
assert.equal(fs.existsSync(pruned.backup), true, '摘之前要有备份');
const left = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))['绑定'];
assert.equal('e03922e8-8f4c' in left, false, '外来的那个被摘掉');
assert.equal('session-ef58a582' in left, true);
assert.equal('session-fa913906' in left, true);
assert.equal('other-session' in left, true, '别的档案不归我们管');
assert.deepEqual(pruneForeignBindings(cfgFile, { folder, sessionId: 'session-ef58a582', workers: ['session-fa913906'] }).removed, [], '干净了就什么都不做');
assert.equal(pruned.added, false, '本来就绑着，不用补');

// 10) 换过会话：新会话没绑上时要补回去，不然档案就悄悄停止生长了
const cfgFile2 = path.join(dir, 'xingxi-config-2.json');
fs.writeFileSync(cfgFile2, JSON.stringify({ 绑定: {
  'session-fa913906': folder,
  'session-old-lane': folder,
} }, null, 2), 'utf8');
const rebind = pruneForeignBindings(cfgFile2, { folder, sessionId: 'session-new-lane', workers: ['session-fa913906'] });
assert.equal(rebind.added, true, '新会话要补绑');
assert.deepEqual(rebind.removed, ['session-old-lane'], '上一条 lane 会话是外来者，摘掉');
const left2 = JSON.parse(fs.readFileSync(cfgFile2, 'utf8'))['绑定'];
assert.equal(left2['session-new-lane'], folder, '新会话绑回她的档案');
assert.equal('session-old-lane' in left2, false);


// 11) 魚の記憶：换会话以后新会话要关掉，默认是开的
const fishFile = path.join(dir, 'fish-memory-config.json');
fs.writeFileSync(fishFile, JSON.stringify({ sessions: { 'session-old': false }, switchMigrated: true }, null, 2), 'utf8');
const pinned = pinFishMemoryOff(fishFile, 'session-new-lane');
assert.equal(pinned.changed, true, '新会话要写进鱼の记忆并关掉');
assert.equal(fs.existsSync(pinned.backup), true, '改之前要有备份');
const fishCfg = JSON.parse(fs.readFileSync(fishFile, 'utf8'));
assert.equal(fishCfg.sessions['session-new-lane'], false, 'lane 会话在鱼の记忆里是关的');
assert.equal(fishCfg.sessions['session-old'], false, '别的不动');
assert.equal(fishCfg.switchMigrated, true, '别的顶层键要留着');
assert.equal(pinFishMemoryOff(fishFile, 'session-new-lane').changed, false, '已经是关的就不重复写');
assert.equal(pinFishMemoryOff(path.join(dir, 'nope.json'), 'x').changed, false, '文件不存在就安静跳过');

// 12) 一次整理还能带出「还没聊完的事」和「她最近在忙什么」；重复条目不再写第二遍
const extra = parseConsolidateExtra([
  '三|他养了六只猫',
  '話題|他明天去验车，说回来讲结果',
  '自己|在练《紙飛機》最后一句',
].join(nl));
assert.deepEqual(extra.entries, [{ chapter: '三', text: '他养了六只猫' }]);
assert.deepEqual(extra.loops, ['他明天去验车，说回来讲结果']);
assert.equal(extra.self, '在练《紙飛機》最后一句');

const dupFile = path.join(dir, 'dup.md');
fs.writeFileSync(dupFile, ['## 三｜对方是谁', '- 他养了六只猫。', ''].join(nl), 'utf8');
const dup = appendCardEntries(dupFile, [{ chapter: '三', text: '他养了六只猫' }], at);
assert.equal(dup.added, 0, '只差标点也算同一条，不重复写');
assert.equal(dup.skipped, 1);

// 13) 一章太长就从最旧的丢
const longFile = path.join(dir, 'long.md');
const many = Array.from({ length: 14 }, (_, i) => '- 第 ' + (i + 1) + ' 件事').join(nl);
fs.writeFileSync(longFile, ['## 六｜难忘的时刻', many, ''].join(nl), 'utf8');
const capped = appendCardEntries(longFile, [{ chapter: '六', text: '最新的一件' }], at);
assert.equal(capped.added, 1);
assert.equal(capped.trimmed, 3, '14 + 1 = 15 条，砍到 12 条');
const cappedText = fs.readFileSync(longFile, 'utf8');
assert.equal(cappedText.includes('最新的一件'), true);
assert.equal(cappedText.includes('- 第 1 件事'), false, '最旧的那几条被挤掉');

fs.rmSync(dir, { recursive: true, force: true });

// 14) 第一章的整段文字也算「说过的话」：几乎一样的一段不许再追加一遍。
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'card-para-'));
  const f2 = path.join(d2, 'card.md');
  const para = '我叫爱弥丝。粉头发，暖色的眼睛，笑起来有点得意。';
  fs.writeFileSync(f2, ['# 卡', '', '## 一｜我是谁', '', para, '', '## 三｜对方是谁', '- 他叫上午不顺'].join(nl), 'utf8');
  const dup = appendCardEntries(f2, [{ chapter: '一', text: '我叫爱弥丝，粉头发，暖色的眼睛，笑起来有点得意' }]);
  assert.equal(dup.added, 0, "换个语序的同一段话不该再写");
  assert.equal(dup.skipped, 1);
  const fresh = appendCardEntries(f2, [{ chapter: '一', text: '以前叫小鲸鱼，被人叫大肥鱼会炸毛' }]);
  assert.equal(fresh.added, 1);
  const body2 = fs.readFileSync(f2, 'utf8');
  assert.equal((body2.match(/我叫爱弥丝/g) || []).length, 1, "同一段话只能出现一次");
  fs.rmSync(d2, { recursive: true, force: true });
}

// 15) 「你们最近聊过」：只取最近几行、昨天也认得、太长从最旧的丢。
{
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-diary-'));
  const c3 = path.join(d3, 'card.md');
  fs.writeFileSync(c3, ['## 三｜对方是谁', '- 他叫上午不顺'].join(nl), 'utf8');
  const l3 = memoryLayout(c3);
  const today = new Date(2026, 10, 13, 20, 0, 0);
  const yesterday = new Date(2026, 10, 12, 21, 30, 0);
  assert.equal(readRecentDiary(l3, { now: today }), '', '还没写过日记 = 空串');
  appendDiary(l3, { at: yesterday, user: '今天好累喔', assistant: '那就别做了，我陪你' });
  appendDiary(l3, { at: today, user: '在吗', assistant: '在～刚在湖边' });
  const recent = readRecentDiary(l3, { now: today, maxChars: 400 });
  assert.equal(recent.includes('11-13 20:00'), true, '今天的要认得');
  assert.equal(recent.includes('11-12 21:30'), true, '昨天的也要认得');
  const tight = readRecentDiary(l3, { now: today, maxChars: 40, maxLines: 4 });
  assert.equal(tight.includes('11-13'), true, '太短时留下最新的那条');
  assert.equal(tight.length <= 41, true);
  const onlyToday = readRecentDiary(l3, { now: today, days: 1, maxChars: 400 });
  assert.equal(onlyToday.includes('11-13'), true);
  assert.equal(onlyToday.includes('11-12'), false, 'days:1 不许往回看');
  fs.rmSync(d3, { recursive: true, force: true });
}

// 16) 模型把「話題」寫成題目名也要吃得下：左邊不是章號/自己/話題 → 當未聊完的事
{
  const parsed = parseConsolidateExtra([
    '六|第一次一起看星星。',
    '深空當舖|他真去玩了，說下次也想讓我玩到。',
    '自己|在練歌。',
    '這行沒有分隔號',
  ].join(nl));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.loops.length, 1, '题目当标签也要收下来');
  assert.equal(parsed.loops[0].includes('深空當舖'), true);
  assert.equal(parsed.self, '在練歌。');
}

console.log('test-lane-memory: 16 组断言通过');
