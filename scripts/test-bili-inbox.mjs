// 测 B站「@ 我」提醒（src/bili-inbox.js）：只提醒新条目、首轮只记水位、失败不吞消息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBiliInbox, formatMentionNotice } from '../src/bili-inbox.js';

let failed = 0;
function check(name, ok, extra = '') {
  if (ok) console.log(`✅ ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failed++;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-inbox-'));
fs.mkdirSync(path.join(root, 'state'), { recursive: true });

const item = (id, kind, extra = {}) => ({
  id,
  kind,
  user: '琥珀之梟',
  uid: '23388718',
  title: '设定图',
  text: '@舜的大肥魚',
  url: 'https://t.bilibili.com/1',
  ...extra,
});

// ── 1. 文案：说清是谁、在哪、说了什么 ────────────────────────────
{
  const text = formatMentionNotice([
    item('1', 'at'),
    item('2', 'reply', { user: '路人', title: '', text: '这图不错' }),
  ]);
  check('文案带昵称', text.includes('琥珀之梟'));
  check('文案区分 @ 与 回复', text.includes('@ 了你') && text.includes('回了你的评论'));
  check('文案带对方原话', text.includes('这图不错'));
  check('文案提醒别在 Discord 复述链接', text.includes('别把整条链接复述到 Discord'));
}

// ── 2. 首轮只记水位，不打扰 ─────────────────────────────────────
const nudges = [];
const lane = { nudge: async (t) => { nudges.push(t); return true; } };
let items = [item('1', 'at')];
const client = { mentions: async (kind) => ({ items: items.filter((i) => i.kind === kind) }) };
const inbox = createBiliInbox({ root, cfg: {}, log: () => {}, lane, client, intervalMs: 60000 });

{
  const res = await inbox.poll();
  check('首轮不提醒', res.fresh === 0 && nudges.length === 0, JSON.stringify(res));
}

// ── 3. 新条目提醒一次，重复不再提醒 ─────────────────────────────
{
  items = [item('1', 'at'), item('9', 'at', { user: '新朋友', text: '你好呀' })];
  const res = await inbox.poll();
  check('新条目提醒一次', res.fresh === 1 && nudges.length === 1, JSON.stringify(res));
  check('提醒里带新朋友的原话', nudges[0]?.includes('你好呀'));
  const again = await inbox.poll();
  check('同一条不重复提醒', again.fresh === 0 && nudges.length === 1);
}

// ── 4. lane 没送出去时不吞 ──────────────────────────────────────
{
  items = [item('10', 'reply', { text: '在吗' })];
  const before = nudges.length;
  const badLane = { nudge: async () => false };
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-inbox-b-'));
  fs.mkdirSync(path.join(root2, 'state'), { recursive: true });
  const inbox2 = createBiliInbox({ root: root2, cfg: {}, log: () => {}, lane: badLane, client, intervalMs: 60000 });
  const first = await inbox2.poll();
  check('新库首轮同样只记水位', first.fresh === 0 && nudges.length === before, JSON.stringify(first));
  items = [item('10', 'reply', { text: '在吗' }), item('11', 'at', { text: '又一条' })];
  const second = await inbox2.poll();
  check('lane 送不出去时返回 ok:false', second.ok === false && nudges.length === before, JSON.stringify(second));
  fs.rmSync(root2, { recursive: true, force: true });
}

// ── 5. 没有 lane 时不炸 ────────────────────────────────────────
{
  const inbox3 = createBiliInbox({ root, cfg: {}, log: () => {}, lane: null, client, intervalMs: 60000 });
  const res = await inbox3.poll();
  check('没有 lane 直接返回', res.ok === false && res.reason === 'no-lane');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\ntest-bili-inbox: 全部通过');
process.exit(failed ? 1 : 0);
