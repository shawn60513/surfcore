// Discord 私訊 lane：讓她在 Discord 上像 QQ 一樣跟你一對一聊天，並且會主動開口。
//
// 為什麼是獨立一條 lane（而不是改 bridge.js 的 QQ 管線）：
//   · bridge.js 的 turn 管線綁死在 SnowLuma 的 QQ 事件（key=group:/private:、唤醒、收尾、tokenGuard），
//     把 Discord 塞進去等於在一個 1MB 的閉包裡再開一個人格分支，風險遠大於收益；
//   · 這裡用「專屬 DSH 會話 + 自帶歷史」的作法：人設從 characters/ 讀同一份，
//     但對話歷史自己存（state/discord-lane.json），所以預設不跟 QQ 共用記憶。
//
// 能力：
//   1) 讀你 DM 的新訊息 → 丟進 DSH 會話跑一輪 → 回覆貼回 DM；
//   2) 閒置超過 idleMinutes 且不在安靜時段 → 主動開話題（prompt 裡給她一個「想不想說話」的判斷）。
//
// 限制：只走 REST（沒有 gateway），所以是輪詢（預設 60s），不是即時推送。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeApiClient, unwrap, createTurnCollector, blocksToText } from './dsh-client.js';
import {
  createDiscordClient,
  loadDiscordConfig,
  resolveDiscordToken,
  discordRequest,
  normalizeMessage,
} from './discord-core.js';
import { readPersonaLayerText, personaNameFromText } from './character-persona.js';
import { discoverDshBaseUrl, isLoopbackBaseUrl, probeDshBaseUrl } from './dsh-port.js';

const LANE_VERSION = 1;
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_IDLE_MINUTES = 120;
const TURN_TIMEOUT_MS = 180_000;
const HISTORY_LIMIT = 24;

// ── 小工具 ────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function clampMs(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Discord 單條訊息上限 2000；超長按段落切，避免把一句話斬斷。 */
function splitContent(text, max = 1900) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('。', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function hourInQuiet(now, quiet) {
  const start = Number(quiet?.start ?? 23);
  const end = Number(quiet?.end ?? 8);
  const h = new Date(now).getHours();
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}


const LANE_LOCK = (root) => path.join(root, 'state', 'discord-lane.lock');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 取得單實例鎖；已有活著的實例就回 null（避免兩個 lane 對同一個 DM 各回一次）。 */
function acquireLock(root) {
  const file = LANE_LOCK(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const raw = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (Number.isInteger(raw) && raw > 0 && raw !== process.pid && pidAlive(raw)) return null;
  } catch {}
  fs.writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (Number(String(fs.readFileSync(file, 'utf8')).trim()) === process.pid) fs.unlinkSync(file);
    } catch {}
  };
}

// ── 回合歸屬 ──────────────────────────────────────────────────────────────
// 同一個 DSH 會話會被多方寫入（DM lane、host adapter、speak-up 念頭、定時任務）。
// 光看「有沒有 turn/start」會抓到別人開的回合，於是回覆只留在 DSH、送不到 Discord。
// 這裡只認「user 訊息正文跟我們送出的 prompt 完全相同」的那一輪——DSH 會原樣保存 prompt。

/** 空白正規化後完全相等的 prompt 正文。 */
export function samePromptText(a, b) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const left = norm(a);
  return left !== '' && left === norm(b);
}

/**
 * 由事件順序判斷「這一輪是不是我發起的」。
 * 兩種順序都要支援：
 *   · turn/start → user/message（一般情況）
 *   · user/message → turn/start（上一個回合還在跑，prompt 被 queue 住）
 */
export function createTurnAttributor() {
  let lastStartTurn = null;
  let lastStartAt = 0;
  let orphans = []; // 先到、還沒對上 turn/start 的 prompt 正文

  return {
    /** turn/start：只有在之前就收到「我們那則 prompt」時才算數（queue 模式）。 */
    onTurnStart(turn, at, promptText) {
      lastStartTurn = turn ?? null;
      lastStartAt = Number(at ?? 0);
      if (lastStartTurn == null || !promptText) return false;
      const hit = orphans.some((item) => samePromptText(item.text, promptText));
      orphans = [];
      return hit;
    },
    /** user/message：一則訊息只可能屬於最近那個 turn/start，取用後就清掉。 */
    onUserMessage(text, promptText, promptedAt) {
      const turn = lastStartTurn;
      const startedAt = lastStartAt;
      lastStartTurn = null;
      lastStartAt = 0;
      if (!promptText || !samePromptText(text, promptText)) return null;
      if (turn != null && startedAt >= Number(promptedAt ?? 0)) {
        orphans = [];
        return turn;
      }
      orphans = [...orphans, { text }].slice(-4);
      return null;
    },
    reset() {
      lastStartTurn = null;
      lastStartAt = 0;
      orphans = [];
    },
  };
}

// ── 人格 ──────────────────────────────────────────────────────────────────

function personaBlock() {
  const core = String(readPersonaLayerText?.('core') ?? '').trim();
  const daily = String(readPersonaLayerText?.('daily') ?? '').trim();
  const name = personaNameFromText(core, '她');
  return { name, text: [core, daily].filter(Boolean).join('\n\n') };
}

// ── 主體 ──────────────────────────────────────────────────────────────────

export function createDiscordLane({ root, cfg, log = console.log, once = false } = {}) {
  const stateFile = path.join(root, 'state', 'discord-lane.json');
  const laneCfg = cfg?.discord?.lane ?? {};
  const enabled = laneCfg.enabled !== false;
  const userId = String(laneCfg.userId ?? '').trim();
  const pollMs = clampMs(laneCfg.pollMs, DEFAULT_POLL_MS, 20_000, 3_600_000);
  const idleMinutes = clampMs(laneCfg.idleMinutes, DEFAULT_IDLE_MINUTES, 5, 24 * 60);
  const quiet = { start: laneCfg.quietStart ?? 23, end: laneCfg.quietEnd ?? 8 };
  const proactiveEnabled = laneCfg.proactive !== false;

  const state = {
    version: LANE_VERSION,
    dmChannelId: '',
    lastMessageId: '',
    sessionId: '',
    workspaceId: '',
    history: [],
    lastUserAt: 0,
    lastBotAt: 0,
    lastProactiveAt: 0,
    ...readJson(stateFile, {}),
  };
  // 本進程啟動時間：用來分辨「DM 裡的歷史訊息」與「啟動後才到的新訊息」。
  state.startedAt = Date.now();

  const save = () => writeJson(stateFile, state);
  const history = () => (Array.isArray(state.history) ? state.history : []).slice(-HISTORY_LIMIT * 2);

  function pushHistory(role, content) {
    const list = Array.isArray(state.history) ? state.history : [];
    list.push({ role, content: String(content ?? '').slice(0, 4000), at: Date.now() });
    state.history = list.slice(-HISTORY_LIMIT * 2);
  }

  // ── Discord 端 ─────────────────────────────────────────────────────────
  const discordCfg = loadDiscordConfig(root);
  const { token, source } = resolveDiscordToken(discordCfg);
  const discordClient = createDiscordClient({ token, cfg: discordCfg });
  if (!token) {
    return { async start() { log(`Discord lane 未啟動：拿不到 bot token（${source}）`); } };
  }

  async function ensureDm() {
    if (state.dmChannelId) {
      try {
        await discordRequest({ token, route: `/channels/${state.dmChannelId}` });
        return state.dmChannelId;
      } catch {
        state.dmChannelId = '';
      }
    }
    const channel = await discordRequest({
      token,
      method: 'POST',
      route: '/users/@me/channels',
      body: { recipient_id: userId },
    });
    state.dmChannelId = String(channel?.id ?? '');
    save();
    return state.dmChannelId;
  }

  async function fetchNew() {
    const channelId = await ensureDm();
    const query = new URLSearchParams({ limit: '20' });
    if (state.lastMessageId) query.set('after', state.lastMessageId);
    const raw = await discordRequest({ token, route: `/channels/${channelId}/messages?${query}` });
    const list = Array.isArray(raw) ? raw : [];
    const mine = new Set();
    const messages = list
      .map((m) => normalizeMessage(m))
      .filter((m) => m && m.authorId)
      .filter((m) => {
        if (m.authorId === mine) return false;
        return true;
      })
      .sort((a, b) => Number(a.id) - Number(b.id));
    return { channelId, messages };
  }

  async function send(text) {
    const channelId = await ensureDm();
    const parts = splitContent(text, 1900).filter(Boolean);
    if (!parts.length) return;
    for (const part of parts) {
      await discordRequest({
        token,
        method: 'POST',
        route: `/channels/${channelId}/messages`,
        body: { content: part, allowed_mentions: { parse: [] } },
      });
    }
  }

  // ── DSH 端 ─────────────────────────────────────────────────────────────
  // 桌面端每次重啟都換回環埠，config.json 的 baseUrl 很容易過期；這裡在啟動時探一次，
  // 只在回環地址上自動修正（遠端 DSH 不動）。
  let api = null;
  async function resolveBaseUrl() {
    const base = cfg.dsh?.baseUrl;
    if (!isLoopbackBaseUrl(base)) return base;
    try {
      if (await probeDshBaseUrl(base)) return base;
    } catch {}
    const found = await discoverDshBaseUrl();
    if (found) {
      cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: found };
      try {
        const file = path.join(root, 'config.json');
        const doc = readJson(file, {});
        doc.dsh = { ...(doc.dsh ?? {}), baseUrl: found };
        writeJson(file, doc);
      } catch {}
      log(`Discord lane：DSH 埠改成 ${found}`);
      return found;
    }
    return base;
  }
  function ensureApi(baseUrl) {
    if (!api) {
      api = new NodeApiClient(baseUrl, undefined, {
        token: cfg.dsh?.authToken,
        tokenExplicit: cfg.dsh?.authTokenExplicit === true,
        header: cfg.dsh?.authHeader,
        prefix: cfg.dsh?.authPrefix,
        allowRemote: cfg.dsh?.allowRemote === true,
      });
    }
    return api;
  }
  let waiting = null; // 當前等待中的回合
  let collector = null;
  let working = false;
  const attributor = createTurnAttributor();

  async function ensureSession() {
    if (state.sessionId && state.workspaceId) {
      try {
        await api.sessions.list({});
        api.events.follow(state.sessionId);
        return state.sessionId;
      } catch {}
    }
    const dir = path.join(root, 'state', 'discord-lane-workspace');
    fs.mkdirSync(dir, { recursive: true });
    const ws = unwrap(await api.workspace.create({ path: dir }), 'discord lane workspace.create');
    state.workspaceId = ws.workspace.workspaceId;
    const created = unwrap(
      await api.sessions.create({ workspaceId: state.workspaceId }),
      'discord lane session.create'
    );
    state.sessionId = created.sessionId;
    api.events.follow(state.sessionId);
    save();
    log(`Discord lane 會話已建立：${state.sessionId}`);
    return state.sessionId;
  }

  async function consumeEvents() {
    const stream = api.events.mux({});
    for await (const envelope of stream) {
      const frame = envelope?.payload;
      if (!frame || frame.type !== 'session/event') continue;
      if (String(frame.sessionId) !== String(state.sessionId)) continue;
      if (!waiting) continue;
      const event = frame.event;

      if (event?.type === 'turn/start') {
        const turn = event.data?.turn ?? null;
        if (attributor.onTurnStart(turn, Date.now(), waiting.promptText, waiting.promptedAt)) {
          waiting.turn = turn;
          collector = createTurnCollector({ tolerantStart: true });
        }
        if (waiting.turn != null && collector) collector.push(event);
        continue;
      }

      if (event?.type === 'user/message' && waiting.turn == null) {
        const text = blocksToText(event.data?.content ?? event.data?.message?.content ?? []);
        const turn = attributor.onUserMessage(text, waiting.promptText, waiting.promptedAt);
        if (turn != null) {
          waiting.turn = turn;
          collector = createTurnCollector({ tolerantStart: true });
        } else {
          continue;
        }
      }

      if (!waiting.turn || !collector) continue;
      if (event?.data?.turn != null && event.data.turn !== waiting.turn) continue;
      const ended = collector.push(event);
      if (!ended) continue;
      const pending = waiting;
      waiting = null;
      collector = null;
      const text = String(ended.text ?? '').trim();
      if (ended.reason?.kind === 'completed' && text) pending.resolve(text);
      else pending.reject(new Error(`turn 未正常完成：${ended.reason?.kind ?? 'unknown'}`));
    }
  }

  async function runTurn(promptText) {
    const sessionId = await ensureSession();
    if (waiting) throw new Error('上一個回合還沒結束');
    const mine = { promptText, promptedAt: Date.now(), turn: null };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiting === mine) {
          waiting = null;
          collector = null;
        }
        reject(new Error('等待回合逾時'));
      }, TURN_TIMEOUT_MS);
      timer.unref?.();
      mine.resolve = (t) => { clearTimeout(timer); resolve(t); };
      mine.reject = (e) => { clearTimeout(timer); reject(e); };
    });
    promise.catch(() => {});
    waiting = mine;
    collector = null;
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    });
    if (!accepted?.result?.ok) {
      if (waiting === mine) waiting = null;
      throw new Error(`prompt 被拒：${accepted?.result?.error?.code ?? ''}`);
    }
    return promise;
  }

  /** 把新訊息包成一次 turn：人設 + 最近歷史 + 這一則。 */
  function replyPrompt(name, text) {
    const persona = personaBlock();
    const log2 = history()
      .map((m) => `${m.role === 'user' ? '對方' : '你'}：${m.content}`)
      .join('\n');
    return [
      persona.text ? `你的人設：\n${persona.text}` : '',
      '',
      '你正在 Discord 上跟對方私訊聊天。只回覆這一段對話，直接給聊天內容，不要解釋你在做什麼。',
      '回覆要口語、簡短（1–3 句），不要用 Markdown 標題或條列。',
      '',
      log2 ? `最近的對話：\n${log2}` : '',
      '',
      `對方剛說：${text}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  function proactivePrompt() {
    const persona = personaBlock();
    const last = history().slice(-6)
      .map((m) => `${m.role === 'user' ? '對方' : '你'}：${m.content}`)
      .join('\n');
    return [
      persona.text ? `你的人設：\n${persona.text}` : '',
      '',
      '你剛好在想對方，想主動在 Discord 私訊裡找他講一句話。',
      '給一句自然的開場（1–2 句），可以延續最近聊過的事，也可以只是想到他。',
      '如果現在完全不適合開口，就只回一個字：跳過。',
      '',
      last ? `最近的對話：\n${last}` : '你們還沒聊過。',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  // ── 主循環 ──────────────────────────────────────────────────────────────

  async function tick() {
    if (working) return;
    working = true;
    try {
      const firstRun = !state.lastMessageId;
      const startedAt = Number(state.startedAt ?? 0);
      const { messages: fetched } = await fetchNew();

      // 第一次跑：本進程啟動之前的歷史訊息只當水位，不回覆。
      if (firstRun) {
        const cutoff = fetched
          .filter((m) => {
            const t = Date.parse(m.timestamp ?? '');
            return Number.isFinite(t) && t < startedAt;
          })
          .at(-1);
        if (cutoff) {
          state.lastMessageId = cutoff.id;
          save();
        }
      }
      const messages = fetched.filter((m) => {
        if (!firstRun) return true;
        const t = Date.parse(m.timestamp ?? '');
        return !Number.isFinite(t) || t >= startedAt;
      });

      if (!state.botId) {
        try {
          state.botId = String((await discordClient.me())?.id ?? '');
          save();
        } catch {}
      }

      for (const msg of messages) {
        if (state.botId && msg.authorId === state.botId) {
          state.lastMessageId = msg.id;
          save();
          continue;
        }
        const content =
          msg.content || '（對方發來一則沒有文字的訊息——可能是圖片或表情，但這裡讀不到內容）';
        try {
          const reply = await runTurn(replyPrompt(String(msg.author ?? ''), content));
          pushHistory('user', content);
          pushHistory('bot', reply);
          state.lastUserAt = Date.now();
          state.lastBotAt = Date.now();
          await send(reply);
          // 送出成功才推水位：模型或網路失敗時，下一輪會重試同一則，而不是讓它永久消失。
          state.lastMessageId = msg.id;
          save();
          log(`Discord lane：回了 ${msg.author ?? ''} 一句`);
        } catch (error) {
          log(`Discord lane 回覆失敗（這則保留，下一輪重試）：${error?.message ?? error}`);
          break;
        }
      }

      // 主動開口
      if (proactiveEnabled && !once) {
        const now = Date.now();
        const last = Math.max(state.lastUserAt ?? 0, state.lastBotAt ?? 0);
        const idleOk = last > 0 && now - last > idleMinutes * 60_000;
        const freshOk = now - (state.lastProactiveAt ?? 0) > idleMinutes * 60_000;
        if (idleOk && freshOk && !hourInQuiet(now, quiet)) {
          state.lastProactiveAt = now;
          save();
          const text = await runTurn(proactivePrompt());
          if (text.replace(/[。！!.…\s]/g, '') !== '跳過') {
            pushHistory('bot', text);
            state.lastBotAt = Date.now();
            save();
            await send(text);
            log('Discord lane：主動開了口');
          } else {
            log('Discord lane：這次決定不開口');
          }
        }
      }
    } catch (error) {
      log(`Discord lane tick 失敗：${error?.message ?? error}`);
    } finally {
      working = false;
    }
  }

  return {
    async start() {
      if (!enabled) return;
      if (!userId) {
        log('Discord lane 未啟動：config.json 缺 discord.lane.userId');
        return;
      }
      // --say / --turn 是維運用的單次命令，不搶鎖（常駐 lane 還在跑時也能用）。
      const adhoc = process.argv.includes('--say') || process.argv.includes('--turn');
      const release = adhoc ? () => {} : acquireLock(root);
      if (!release) {
        log('Discord lane 未啟動：已有另一個實例在跑（state/discord-lane.lock）');
        return;
      }
      process.once('exit', release);
      log(`Discord lane 啟動：user=${userId} poll=${pollMs}ms idle=${idleMinutes}min token=${source}`);
      try {
        const baseUrl = await resolveBaseUrl();
        ensureApi(baseUrl);
        await ensureDm();
        await ensureSession();
      } catch (error) {
        log(`Discord lane 初始化失敗：${error?.message ?? error}`);
        return;
      }
      consumeEvents().catch((error) => log(`Discord lane 事件流中斷：${error?.message ?? error}`));
      await tick();
      if (once) return;
      setInterval(() => { tick(); }, pollMs);
    },
    tick,
    send,
    /** 只跑一次模型回合、不發 Discord：用來單獨驗證 DSH 那半條鏈路。 */
    turn: (text) => runTurn(replyPrompt('', text)),
    state,
  };
}

// 直接 `node src/discord-lane.js` 可當獨立 daemon 跑（不經 bridge）。
// 用法：
//   node src/discord-lane.js             # 常駐（預設 60s 輪詢）
//   node src/discord-lane.js --once      # 只跑一輪（建立 DM 與會話）
//   node src/discord-lane.js --say 你好   # 只發一條私訊，驗證連線
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const cfg = readJson(path.join(root, 'config.json'), {});
  const once = process.argv.includes('--once') || process.argv.includes('--say') || process.argv.includes('--turn');
  const sayIndex = process.argv.indexOf('--say');
  const lane = createDiscordLane({ root, cfg, once });
  await lane.start();
  const turnIndex = process.argv.indexOf('--turn');
  if (turnIndex >= 0) {
    const text = process.argv.slice(turnIndex + 1).join(' ').trim() || '你好';
    const reply = await lane.turn(text);
    console.log(reply);
    process.exit(0);
  }
  if (sayIndex >= 0) {
    const text = process.argv.slice(sayIndex + 1).join(' ').trim();
    if (!text) {
      console.error('--say 后面要跟一句话');
      process.exit(1);
    }
    await lane.send(text);
    console.log('已發送');
    process.exit(0);
  }
  if (!once) setInterval(() => {}, 1 << 30);
}
