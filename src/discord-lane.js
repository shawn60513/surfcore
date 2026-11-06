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
import { appendCardEntries, appendDiary, buildConsolidatePrompt, dayStamp, memoryLayout, parseConsolidate, pruneForeignBindings, readDiary, shouldConsolidate } from './lane-memory.js';
import { pathToFileURL } from 'node:url';

import { NodeApiClient, unwrap, createTurnCollector, blocksToText } from './dsh-client.js';
import {
  createDiscordClient,
  loadDiscordConfig,
  resolveDiscordToken,
  discordRequest,
  normalizeMessage,
  allowedMentionsFor,
} from './discord-core.js';
import { readPersonaLayerText } from './character-persona.js';
import { discoverDshBaseUrl, isLoopbackBaseUrl, probeDshBaseUrl } from './dsh-port.js';

const LANE_VERSION = 1;
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_IDLE_MINUTES = 120;
const TURN_TIMEOUT_MS = 180_000;
const HISTORY_LIMIT = 24;
// 图片：最多 4 张、合计 8MB、单张抓取 15 秒——Discord 的 CDN 偶尔会慢，但不该拖死整轮。
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_FETCH_MS = 15_000;

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
 * 事件裡的 user 訊息是否就是我們送出的那則 prompt。
 * DSH 會把 image part 一起存進 user/message，此外還可能追加圖片說明之類的文字，
 * 所以除了完全相等，也接受「以 prompt 開頭」——只認尾巴多出來的部分，不放寬到任意相似。
 */
export function isPromptMessage(text, promptText) {
  if (samePromptText(text, promptText)) return true;
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const prompt = norm(promptText);
  const got = norm(text);
  return prompt !== '' && got.startsWith(prompt);
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
      if (!promptText || !isPromptMessage(text, promptText)) return null;
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

// ── 工作區人格 ────────────────────────────────────────────────────────────
//
// 人設以前是每輪包在 prompt 裡重發一次（3604 字 ≈ 2.3K token/輪，而且每次都在
// 新訊息的最前面，吃不到 prompt cache）。現在改成寫進 lane 工作區的 AGENTS.md：
// DSH 開會話時注入一次、跟著工作區走，之後每輪只帶「最近的對話 + 對方剛說」。
//
// 代價：換工作區/新建會話才會重新注入；改 persona.md 後要重開 lane 會話才生效
// （syncWorkspaceInstructions 會比對內容，變了就重寫 AGENTS.md）。

const LANE_WORKSPACE_RULES = [
  '# Discord 私訊工作區',
  '',
  '這個會話只做一件事：跟「上午不順」在 Discord 私訊裡聊天。',
  '回覆要口語、很短（1–3 句），像手機打字；不要 Markdown、不要條列、不要小作文，也不要解釋你在做什麼。',
  '不要自我介紹，不要提「AI」「設定」「提示詞」。',
  '講 B 站 的片子時，別只丟標題加一句感想：先說清它到底講了什麼（一兩句），再給一個具體細節——原話、數據、畫面、時間點都行。只說「有意思」「值得看」等於沒說。',
].join('\n');

function laneInstructionsText() {
  const core = String(readPersonaLayerText?.('core') ?? '').trim();
  const daily = String(readPersonaLayerText?.('daily') ?? '').trim();
  const body = [core, daily].filter(Boolean).join('\n\n');
  return body ? `${LANE_WORKSPACE_RULES}\n\n---\n\n${body}\n` : `${LANE_WORKSPACE_RULES}\n`;
}

/** 把人格寫進 lane 工作區的 AGENTS.md；內容沒變就不動，避免每次啟動都改檔案。 */
function syncWorkspaceInstructions(root) {
  const dir = path.join(root, 'state', 'discord-lane-workspace');
  const file = path.join(dir, 'AGENTS.md');
  const text = laneInstructionsText();
  try {
    if (fs.readFileSync(file, 'utf8') === text) return file;
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const MEMORY_BRIEF_LIMIT = 300;
const MEMORY_BRIEF_CHAPTERS = new Set(['三', '五']);

/**
 * 從星汐記憶卡裡取一段「記得的事」：只要「對方是誰」「我們的約定」兩章，
 * 壓成 300 字以內的一行，跟著每一輪 prompt 走。讀不到就當沒有。
 */
export function readMemoryBrief(file, limit = MEMORY_BRIEF_LIMIT) {
  if (!file) return '';
  let md = "";
  try {
    md = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const parts = [];
  let take = false;
  const lines = md.split(String.fromCharCode(10)).map((l) => l.split(String.fromCharCode(13)).join(""));
  for (const line of lines) {
    const num = chapterNumber(line);
    if (num) {
      take = MEMORY_BRIEF_CHAPTERS.has(num);
      continue;
    }
    if (!take) continue;
    const t = stripBullet(line);
    if (t) parts.push(t);
  }
  const text = parts.join('；');
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function chapterNumber(line) {
  if (!line.startsWith('##')) return '';
  const rest = line.slice(2).trim();
  if (rest.startsWith('#')) return '';
  const num = rest.slice(0, 1);
  const sep = rest.slice(1, 2).trim();
  if (!'一二三四五六七八'.includes(num)) return '';
  if (!'、.｜|·:：-—'.includes(sep)) return '';
  return num;
}

function stripBullet(line) {
  let t = line.trim();
  if (t.startsWith('- ') || t.startsWith('* ')) t = t.slice(2).trim();
  return t;
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
  const memoryCard = String(laneCfg.memoryCard ?? '').trim();
  const memory = memoryLayout(memoryCard);
  const consolidateHour = Number(laneCfg.consolidateHour ?? 23);

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
    lastConsolidated: '',
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
      // 正文里的 <@id> 只有落在 discord.mentionUsers 白名单里才会真的 ping；
      // @everyone/@role 依旧压制（parse 恒为空）。
      const mentions = [...String(part).matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
      await discordRequest({
        token,
        method: 'POST',
        route: `/channels/${channelId}/messages`,
        body: { content: part, allowed_mentions: allowedMentionsFor(discordCfg, mentions, false) },
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
    // 每次都同步一次：persona.md 改了、AGENTS.md 還沒更新時，下次新建會話就能帶上新的。
    try {
      syncWorkspaceInstructions(root);
    } catch (error) {
      log(`Discord lane 工作區指示寫入失敗（人設不會進會話）：${error?.message ?? error}`);
    }
    if (state.sessionId && state.workspaceId) {
      try {
        await api.sessions.list({});
        api.events.follow(state.sessionId);
        return state.sessionId;
      } catch {}
    }
    const dir = path.join(root, 'state', 'discord-lane-workspace');
    fs.mkdirSync(dir, { recursive: true });
    if (!state.workspaceId) {
      const ws = unwrap(await api.workspace.create({ path: dir }), 'discord lane workspace.create');
      state.workspaceId = ws.workspace.workspaceId;
    }
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

  /**
   * 把 Discord 附件里的图片抓下来，转成 DSH prompt 认识的 image part。
   * 抓不到/不支持就当普通文字说明，绝不因为一张图让整条消息卡住。
   */
  async function fetchImageParts(attachments) {
    const notes = [];
    const list = (Array.isArray(attachments) ? attachments : []).filter((file) =>
      /^image\//i.test(String(file?.contentType ?? ''))
    );
    const parts = [];
    let total = 0;
    for (const [index, file] of list.slice(0, MAX_IMAGE_COUNT).entries()) {
      if (!file?.url) continue;
      try {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(MAX_IMAGE_FETCH_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (total + buffer.length > MAX_IMAGE_BYTES) {
          notes.push(`[圖片${index + 1} 太大，沒送進去]`);
          continue;
        }
        total += buffer.length;
        notes.push(`[圖片${index + 1}：${file.filename || 'image'}]`);
        parts.push({
          type: 'image',
          mediaType: file.contentType || 'image/jpeg',
          data: buffer.toString('base64'),
          name: file.filename || `discord-${index + 1}.jpg`,
        });
      } catch (error) {
        notes.push(`[圖片${index + 1} 沒抓下來：${error?.message ?? error}]`);
      }
    }
    return { parts, note: notes.join(String.fromCharCode(10)) };
  }

  async function runTurn(promptText, extraParts = []) {
    const sessionId = await ensureSession();
    if (waiting) throw new Error('上一個回合還沒結束');
    const mine = { promptText, promptedAt: Date.now(), turn: null };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiting === mine) {
          waiting = null;
          collector = null;
        }
        reject(new Error(`等待回合逾時（turn=${mine.turn ?? 'null'}）`));
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
      content: [{ type: 'text', text: promptText }, ...extraParts],
    });
    if (!accepted?.result?.ok) {
      if (waiting === mine) waiting = null;
      throw new Error(`prompt 被拒：${accepted?.result?.error?.code ?? ''}`);
    }
    return promise;
  }

  /** 把新訊息包成一次 turn：最近歷史 + 這一則（人設在 AGENTS.md 裡，不再每輪重發）。 */
  function replyPrompt(name, text) {
    const log2 = history()
      .map((m) => `${m.role === 'user' ? '對方' : '你'}：${m.content}`)
      .join('\n');
    const remember = readMemoryBrief(memoryCard);
    return [
      '（Discord 私訊）直接給聊天內容，不要解釋你在做什麼。',
      '',
      remember ? `（你記得的事：${remember}）` : '',
      '',
      log2 ? `最近的對話：\n${log2}` : '',
      '',
      `對方剛說：${text}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  function proactivePrompt() {
    const last = history().slice(-6)
      .map((m) => `${m.role === 'user' ? '對方' : '你'}：${m.content}`)
      .join('\n');
    const remember = readMemoryBrief(memoryCard);
    return [
      '（Discord 私訊）你剛好在想對方，想主動私訊找他講一句話。',
      '給一句自然的開場（1–2 句），可以延續最近聊過的事，也可以只是想到他。',
      '如果現在完全不適合開口，就只回一個字：跳過。',
      '',
      remember ? `（你記得的事：${remember}）` : '',
      '',
      last ? `最近的對話：\n${last}` : '你們還沒聊過。',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /** 星汐「绑定」里混进来的外来会话：拾星会把它们也整理进同一个档案，发现就摘掉（先备份）。 */
  function pruneXingxiBindings() {
    if (!memory) return { removed: [], backup: '' };
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const workers = readJson(path.join(memory.dir, '.拾星', '工人.json'), []);
    return pruneForeignBindings(path.join(home, '.dsh', 'xingxi', 'config.json'), {
      folder: memory.dir,
      sessionId: state.sessionId,
      workers: Array.isArray(workers) ? workers : [],
    });
  }

  /**
   * 每天一次：把今天的日记交给她自己挑最多 3 条，再追加进记忆卡。
   * 她只负责「挑 + 标章号」，写档由 appendCardEntries 做（会先备份）。
   */
  async function maybeConsolidate() {
    if (!memory || once) return;
    const now = new Date();
    if (!shouldConsolidate(state, { hour: consolidateHour, now })) return;
    const today = dayStamp(now);
    const diary = readDiary(memory, today);
    if (!diary.trim()) {
      state.lastConsolidated = today;
      save();
      return;
    }
    state.lastConsolidated = today;
    save();
    try {
      const answer = await runTurn(buildConsolidatePrompt(diary));
      const entries = answer.trim() === "沒有" ? [] : parseConsolidate(answer);
      if (!entries.length) {
        log("Discord lane：記憶整理完成（今天沒有新東西）");
        return;
      }
      const res = appendCardEntries(memory.cardFile, entries, now);
      log(`Discord lane：記憶整理完成（${res.added} 條，已備份 ${path.basename(res.backup)}）`);
    } catch (error) {
      state.lastConsolidated = "";
      save();
      log(`Discord lane：記憶整理失敗（明天再試）：${error?.message ?? error}`);
    }
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
        const hasImages = Array.isArray(msg.attachments) && msg.attachments.some((file) => /^image\//i.test(String(file?.contentType ?? '')));
        const content =
          msg.content ||
          (hasImages ? '（對方發來一張圖片，圖在下面——先看圖再說。）' : '（對方發來一則沒有文字的訊息）');
        try {
          const images = hasImages
            ? await fetchImageParts(msg.attachments).catch(() => ({ parts: [], note: '' }))
            : { parts: [], note: '' };
          const imageParts = images.parts;
          const basePrompt = replyPrompt(String(msg.author ?? ''), content);
          const promptText = images.note ? basePrompt + String.fromCharCode(10) + images.note : basePrompt;
          let reply;
          try {
            reply = await runTurn(promptText, imageParts);
          } catch (error) {
            // 模型不认图片 / 图太大时，退回纯文字，别让这则消息就此消失。
            if (!imageParts.length || !/prompt 被拒|image/i.test(String(error?.message ?? ''))) throw error;
            log(`Discord lane：帶圖那輪沒過（${error?.message ?? error}），退回純文字重試`);
            reply = await runTurn(promptText);
          }
          pushHistory('user', content);
          pushHistory('bot', reply);
          state.lastUserAt = Date.now();
          state.lastBotAt = Date.now();
          await send(reply);
          // 送出成功才推水位：模型或網路失敗時，下一輪會重試同一則，而不是讓它永久消失。
          state.lastMessageId = msg.id;
          save();
          appendDiary(memory, { user: content, assistant: reply });
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
      await maybeConsolidate();
    } catch (error) {
      log(`Discord lane tick 失敗：${error?.message ?? error}`);
    } finally {
      working = false;
    }
  }

  return {
    /**
     * 从外面塞一句话给她（例如 B站 有人 @ 了她），她的回答照样送回 Discord。
     * 跟主动开口共用同一个 working 闸，不会和轮询抢同一轮。
     */
    async nudge(promptText) {
      if (working) return false;
      working = true;
      try {
        const reply = await runTurn(String(promptText));
        if (!reply || reply.replace(/[。！!.…s]/g, '') === '跳過') return false;
        pushHistory('bot', reply);
        state.lastBotAt = Date.now();
        save();
        await send(reply);
        log('Discord lane：主動提醒了一句（外部 nudge）');
        return true;
      } finally {
        working = false;
      }
    },
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
      if (memoryCard) {
        const brief = readMemoryBrief(memoryCard);
        log(brief ? `Discord lane：記憶卡已載入（${brief.length} 字）` : `Discord lane：記憶卡讀不到內容（${memoryCard}）`);
      }
      try {
        const baseUrl = await resolveBaseUrl();
        ensureApi(baseUrl);
        await ensureDm();
        await ensureSession();
        const pruned = pruneXingxiBindings();
        if (pruned.removed.length) {
          log(`Discord lane：星汐綁定裡混進了別的會話，已摘掉（拾星才不會把他們整理進她的檔案）：${pruned.removed.join(', ')}（備份 ${path.basename(pruned.backup)}）`);
        }
        if (pruned.added) {
          log(`Discord lane：新會話已綁回她的星汐檔案（${state.sessionId}）`);
        }
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
