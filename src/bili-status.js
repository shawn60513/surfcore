// 只读的 B站 例行状态摘要：今天刷了几轮、判重多大、窗口还剩。
// 供排查「她今天怎么没刷」时一眼看清，不用翻日志。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DUTY_DIR = () => path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.dsh', 'bili-duty',
);

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadBiliDutySnapshot({ dutyDir } = {}) {
  const dir = dutyDir || DEFAULT_DUTY_DIR();
  const cfg = readJsonSafe(path.join(dir, 'config.json'), {});
  const state = readJsonSafe(path.join(dir, 'state.json'), {});
  let seen = '';
  try {
    seen = fs.readFileSync(path.join(dir, 'seen.md'), 'utf8');
  } catch {}
  return { dir, cfg, state, seen };
}

export function countSeenBvs(seen) {
  const after = String(seen ?? '').split('## 看过的视频')[1] ?? '';
  const sec = after.split(/^## /m)[0];
  const bvs = new Set();
  for (const m of sec.matchAll(/BV[0-9A-Za-z]{10}/g)) bvs.add(m[0]);
  return { count: bvs.size, latest: [...bvs].slice(0, 10) };
}

export function formatBiliStatus(snap) {
  const { cfg, state, seen } = snap;
  const lines = [];
  lines.push('B站 例行状态（只读摘要）');
  lines.push(`- 自动刷：${cfg?.autoMode ?? '未设'}（peakValley=${cfg?.peakValley ?? false}，perScan=${cfg?.perScan ?? 1}）`);
  const seenInfo = countSeenBvs(seen);
  lines.push(`- 判重表：已看过 ${seenInfo.count} 个 BV${seenInfo.latest.length ? `，最近：${seenInfo.latest.join('、')}` : ''}`);
  lines.push(`- 今天：count=${state?.count ?? '?'}，picked=${state?.picked ?? '?'}${state?.date ? `（${state.date}）` : ''}`);
  if (cfg?.dynamicOn || cfg?.dynamicAutoOn) lines.push('- ⚠️ 发动态开关开着（主页动态可能被手机验证挡住）');
  else lines.push('- 发动态：关');
  lines.push(`- 目录：${snap.dir}`);
  return lines.join('\n');
}

// CLI：node src/bili-status.js 直接打印当前状态
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase().endsWith('bili-status.js')) {
  console.log(formatBiliStatus(loadBiliDutySnapshot()));
}
