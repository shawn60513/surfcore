#!/usr/bin/env node
// 拿「影片裡到底說了什麼」——把字幕／自動字幕抓下來，印成純文字。
//
// 用法：
//   node scripts/watch-words.mjs <url> [--max 4000] [--lang "zh.*,en.*"]
//
// 能拿到 → 印出字幕原文（前 N 字）。
// 拿不到 → 印「沒有字幕」，退出碼 1，呼叫端照實說「我這兒只有畫面」。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
if (!url) {
  console.error('用法：node scripts/watch-words.mjs <影片網址> [--max 4000] [--lang "zh.*,en.*"]');
  process.exit(2);
}

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
};
const maxChars = Math.max(200, Math.min(20000, Number(flag('max', 4000)) || 4000));
const langs = flag('lang', 'zh.*,zh-Hant.*,en.*');

const bin = process.env.YT_DLP || 'yt-dlp';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-words-'));

function run(argv) {
  return spawnSync(bin, argv, { encoding: 'utf8', timeout: 180000, windowsHide: true });
}

const meta = run(['-J', '--no-warnings', '--no-playlist', url]);
if (meta.status !== 0) {
  const err = String(meta.stderr || '').trim().split('\n').slice(-2).join(' ');
  console.log(`拿不到這支影片：${err || 'yt-dlp 失敗'}`);
  process.exit(1);
}
let info = {};
try {
  info = JSON.parse(meta.stdout);
} catch {}
const title = info.title || '';
const seconds = Number(info.duration) || 0;

run([
  '--skip-download',
  '--no-warnings',
  '--no-playlist',
  '--write-subs',
  '--write-auto-subs',
  '--sub-langs',
  langs,
  '--sub-format',
  'vtt',
  '-o',
  path.join(dir, 'sub.%(ext)s'),
  url,
]);

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.vtt'));
if (!files.length) {
  console.log(`${title ? `《${title}》` : '這支影片'}沒有字幕檔（也沒抓到自動字幕）——只有畫面可看。`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

function clean(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT' || line.startsWith('NOTE')) continue;
    if (/^\d+$/.test(line)) continue;
    if (line.includes('-->')) continue;
    if (/^(Kind|Language|Style|Region):/i.test(line)) continue;
    const plain = line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!plain) continue;
    if (out[out.length - 1] === plain) continue;
    out.push(plain);
  }
  return out.join('\n');
}

let text = '';
for (const f of files) {
  const part = clean(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (part.length > text.length) text = part;
}
fs.rmSync(dir, { recursive: true, force: true });

if (!text) {
  console.log('字幕檔是空的。');
  process.exit(1);
}

const mm = Math.floor(seconds / 60);
const ss = Math.floor(seconds % 60);
console.log(`《${title}》${seconds ? `${mm}分${String(ss).padStart(2, '0')}秒` : ''}`);
console.log('---');
console.log(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
