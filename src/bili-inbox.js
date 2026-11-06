// B站「@ 我」提醒 → Discord 私訊 lane。
//
// 背景：`bili_mentions` 是「问一句才看一次」，愛彌絲 在 Discord 里聊着聊着不会自己想起来去翻；
// 于是有人在 B站 @ 她，主人那边一直等不到消息。这里每 10 分钟替她翻一次，
// 有新 @ / 新回复就通过 lane.nudge() 塞一句话给她，她的回答照常送回 Discord。
//
// 边界：
// - 只看 at / reply，不看点赞（点赞不是"要我搭话"的信号）；
// - 第一次跑只记水位、不提醒（免得一启动就把历史二十条全推一遍）；
// - 同一 id 只提醒一次；state/bili-inbox.json 里最多留 200 个 id；
// - 不代替她回 B站，也不代替她在 Discord 复述整条链接。
import fs from 'node:fs';
import path from 'node:path';
import { loadBiliConfig, readCredential, createBiliClient } from './bili-core.js';

const STATE_NAME = 'bili-inbox.json';
const SEEN_LIMIT = 200;
export const DEFAULT_INBOX_INTERVAL_MS = 10 * 60 * 1000;

function readState(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { seen: Array.isArray(doc.seen) ? doc.seen.map(String) : [] };
  } catch {
    return { seen: [] };
  }
}

function writeState(file, state) {
  const seen = state.seen.slice(-SEEN_LIMIT);
  fs.writeFileSync(file, JSON.stringify({ seen, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

/** 把一条 B站 提醒写成「说给模型听的一句话」。 */
export function formatMentionNotice(items) {
  const lines = items.map((it) => {
    const who = it.user || `UID ${it.uid}`;
    const where = it.title ? `《${it.title}》下` : '一条内容下';
    const what = it.kind === 'reply' ? '回了你的评论' : '@ 了你';
    const said = it.text ? `：「${it.text.replace(/\s+/g, ' ').slice(0, 120)}」` : '';
    return `· ${who} 在${where}${what}${said}${it.url ? `\n  ${it.url}` : ''}`;
  });
  return [
    '（B站 提醒，不是 Discord 里的话）',
    '有人在你 B站 那边找你：',
    ...lines,
    '想回就在评论区用 bili_reply 回（正文别手打 @，B站 会自己加「回复 @某某」）；',
    '想让主人知道就一句话带过，别把整条链接复述到 Discord。',
  ].join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.root           项目根（读 config.json、写 state/）
 * @param {object} opts.cfg            config.json（只用 bili.enabled 与 bili.credentialPath）
 * @param {(msg:string)=>void} [opts.log]
 * @param {{nudge:(text:string)=>Promise<boolean>}} opts.lane
 * @param {object} [opts.client]       注入用：{ mentions(kind) }
 * @param {number} [opts.intervalMs]
 */
export function createBiliInbox({ root, cfg, log = () => {}, lane, client, intervalMs = DEFAULT_INBOX_INTERVAL_MS } = {}) {
  const stateFile = path.join(root, 'state', STATE_NAME);
  let timer = null;
  let working = false;
  let lastQuietLog = 0;

  function resolveClient() {
    if (client) return client;
    const biliCfg = loadBiliConfig(root);
    if (biliCfg.enabled === false) return null;
    const cred = readCredential(biliCfg.credentialPath);
    return createBiliClient({ cred, cfg: biliCfg });
  }

  async function poll() {
    if (working || !lane || typeof lane.nudge !== 'function') return { ok: false, reason: 'no-lane' };
    if (cfg?.bili?.enabled === false) return { ok: false, reason: 'disabled' };
    working = true;
    try {
      const api = resolveClient();
      if (!api) return { ok: false, reason: 'disabled' };
      const [at, reply] = await Promise.all([
        api.mentions('at').catch((e) => ({ items: [], error: e?.message ?? String(e) })),
        api.mentions('reply').catch((e) => ({ items: [], error: e?.message ?? String(e) })),
      ]);
      const items = [...(at.items ?? []), ...(reply.items ?? [])];
      if (!items.length) return { ok: true, fresh: 0 };

      const state = readState(stateFile);
      const seen = new Set(state.seen);
      const fresh = items.filter((it) => it.id && !seen.has(`${it.kind}:${it.id}`));

      // 第一次跑（没有任何记录）：只记水位，不打扰。
      if (!state.seen.length) {
        for (const it of items) seen.add(`${it.kind}:${it.id}`);
        writeState(stateFile, { seen: [...seen] });
        log(`B站提醒：首次記錄 ${items.length} 條水位，不提醒`);
        return { ok: true, fresh: 0, seeded: items.length };
      }

      if (!fresh.length) {
        const now = Date.now();
        if (now - lastQuietLog > 3600_000) {
          lastQuietLog = now;
          log(`B站提醒：看過一輪，沒有新的 @ / 回覆（seen ${seen.size} 條）`);
        }
        return { ok: true, fresh: 0 };
      }

      const ok = await lane.nudge(formatMentionNotice(fresh));
      if (ok) {
        for (const it of fresh) seen.add(`${it.kind}:${it.id}`);
        writeState(stateFile, { seen: [...seen] });
        log(`B站提醒：推了 ${fresh.length} 條給 lane`);
      } else {
        log(`B站提醒：lane 沒送出去（${fresh.length} 條留著，下次再推）`);
      }
      return { ok, fresh: fresh.length };
    } catch (error) {
      log(`B站提醒失敗：${error?.message ?? error}`);
      return { ok: false, reason: error?.message ?? String(error) };
    } finally {
      working = false;
    }
  }

  return {
    poll,
    start() {
      if (cfg?.bili?.enabled === false) {
        log('B站提醒：bili.enabled=false，不啟動');
        return;
      }
      if (!lane) {
        log('B站提醒：沒有 lane，不啟動');
        return;
      }
      poll();
      timer = setInterval(() => { poll(); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      log(`B站提醒：已啟動（每 ${Math.round(intervalMs / 60000)} 分鐘看一次 @ / 回覆）`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
