// 离线测试 src/bili-status.js 的纯函数（不碰 ~/.dsh）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBiliDutySnapshot, countSeenBvs, formatBiliStatus, DEFAULT_DUTY_DIR } from '../src/bili-status.js';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`✗ ${name}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-status-'));

// 1. 空目录也不炸
{
  const snap = loadBiliDutySnapshot({ dutyDir: tmp });
  ok('空目录 load 不炸', !!snap && snap.cfg !== undefined);
  ok('空目录 format 不炸', formatBiliStatus(snap).includes('B站 例行状态'));
}

// 2. 有数据时摘要内容
{
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ autoMode: 'valley', peakValley: true, perScan: 3 }));
  fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ date: '2026-11-08', count: 4, picked: 4 }));
  fs.writeFileSync(path.join(tmp, 'seen.md'), '# 刷B站 · 判重表\n## 看过的视频\n- BV1sdxW6VEui\n- BV1ednc6jE3j\n## 其他\n- BV1QH4h6kERj');
  const snap = loadBiliDutySnapshot({ dutyDir: tmp });
  const text = formatBiliStatus(snap);
  ok('含自动刷模式', text.includes('valley') && text.includes('perScan=3'));
  ok('含判重数量', text.includes('已看过 2 个 BV'));
  ok('含今天轮数', text.includes('count=4') && text.includes('picked=4'));
  ok('发动态默认关', text.includes('发动态：关'));
  const info = countSeenBvs(snap.seen);
  ok('判重只认看过视频节', info.count === 2 && info.latest.length === 2 && info.latest[0] === 'BV1sdxW6VEui');
}

// 3. 发动态开着会警告
{
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ dynamicOn: true, dynamicAutoOn: true }));
  const snap = loadBiliDutySnapshot({ dutyDir: tmp });
  ok('发动态开有警告', formatBiliStatus(snap).includes('⚠️'));
}

// 4. DEFAULT_DUTY_DIR 指向 ~/.dsh/bili-duty
ok('默认目录含 .dsh/bili-duty', DEFAULT_DUTY_DIR().endsWith(path.join('.dsh', 'bili-duty')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`test-bili-status: ${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
