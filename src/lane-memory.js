// 星汐記憶卡 / 日記的讀寫。
//
// 為什麼要這個檔案：lane 原本只「讀」記憶卡摘要，說的新話寫不回去。
// 這裡補上兩件事：
//   1. 每一輪對話自動追加到 `日記/YYYY-MM-DD.md`（不用模型，零成本，不會漏）。
//   2. 每天晚上派一輪「整理」給她自己挑重點，解析成「章號|內容」後追加進 `記憶卡.md`。
//
// 刻意不讓模型直接改檔：她改壞格式（章標題、縮排）就整章讀不到，
// 而且備份/原子寫入這些事模型做不穩。這裡只讓她「選内容」，寫檔由程式做。
import fs from 'node:fs';
import path from 'node:path';

/** 一条日记行的正文上限：太长的消息截断，别把日记写成聊天记录。 */
const MAX_LINE = 200;

/** 允许追加到记忆卡的章：一（我是谁）、三（对方是谁）、五（约定）、六（难忘的时刻）。 */
export const CARD_CHAPTERS = new Set(['一', '三', '五', '六']);

export function memoryLayout(cardFile) {
  const file = String(cardFile ?? '').trim();
  if (!file) return null;
  const dir = path.dirname(file);
  return { cardFile: file, dir, diaryDir: path.join(dir, '日记') };
}

function two(n) {
  return String(n).padStart(2, '0');
}

export function dayStamp(at = new Date()) {
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

export function clockStamp(at = new Date()) {
  return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

export function diaryPath(layout, date = dayStamp()) {
  return path.join(layout.diaryDir, `${date}.md`);
}

function oneLine(text, limit = MAX_LINE) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

/**
 * 把一轮对话追加进今天的日记。失败只返回 ''，不抛——记忆坏了不能影响回消息。
 */
export function appendDiary(layout, { at = new Date(), user = '', assistant = '' } = {}) {
  if (!layout) return '';
  const date = dayStamp(at);
  const file = diaryPath(layout, date);
  const who = oneLine(user);
  const what = oneLine(assistant);
  if (!who && !what) return '';
  const line = what ? `- **${clockStamp(at)}** 他：${who} → 我：${what}` : `- **${clockStamp(at)}** 他：${who}`;
  try {
    fs.mkdirSync(layout.diaryDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `【${date}】\n\n`, 'utf8');
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    return file;
  } catch {
    return '';
  }
}

/** 读某天的日记（没有就空串）。 */
export function readDiary(layout, date = dayStamp()) {
  if (!layout) return '';
  try {
    return fs.readFileSync(diaryPath(layout, date), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 「你还记得刚才/昨天聊过什么」：把最近一两天的日记压成几行。
 *
 * 只取最近 4 行、从最新的往回拼，超过 maxChars 就从最旧那行开始丢——
 * 记忆卡是长期结论，这里补的是「热乎的上下文」。
 */
export function readRecentDiary(layout, { now = new Date(), days = 2, maxChars = 260, maxLines = 4 } = {}) {
  if (!layout) return '';
  const picked = [];
  for (let back = 0; back < Math.max(1, days) && picked.length < maxLines; back += 1) {
    const at = new Date(now.getTime() - back * 86_400_000);
    const date = dayStamp(at);
    const text = readDiary(layout, date);
    if (!text) continue;
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => {
        const m = /^-\s+\*\*(\d{2}:\d{2})\*\*\s*(.*)$/.exec(line);
        if (!m) return '';
        const stamp = date.slice(5);
        return `${stamp} ${m[1]} ${m[2]}`;
      })
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && picked.length < maxLines; i -= 1) {
      picked.push(lines[i]);
    }
  }
  if (!picked.length) return '';
  picked.reverse();
  // 太長就從最舊那行開始丟，保證留下的都是最近的。
  let lines = picked.slice();
  const joined = () => lines.join('\n');
  while (lines.length > 1 && joined().length > maxChars) lines = lines.slice(1);
  const out = joined();
  return out.length > maxChars ? `${out.slice(out.length - maxChars)}…` : out;
}

/**
 * 整理用的提示词：只让她「挑 + 标章号」，不让她写文件。
 */
export function buildConsolidatePrompt(diaryText) {
  return [
    '（整理記憶，不是聊天）下面是你今天跟他說過的話。',
    '',
    '第一部分：挑最多 3 條值得長期記住的，每行一條，格式：章號|內容',
    '章號只能用：三（他是誰／他的事）、五（你們的約定）、六（難忘的時刻）。',
    '只寫新的、以後還用得上的；流水賬、寒暄、已經記過的不寫。',
    '',
    '第二部分：挑最多 2 件「話還沒說完的事」（他提過但還沒結果的），每行一條，格式：話題|一句話',
    '左邊固定寫「話題」兩個字，不要把題目放左邊；題目寫在右邊那句話裡。',
    '例如：話題|他明天要去驗車，說回來再講結果。沒有就整段不寫。',
    '',
    '第三部分：用一句話寫你最近在忙什麼（練歌／看片／在湖邊），格式：自己|一句話。沒什麼好寫就整段不寫。',
    '',
    '如果今天完全沒有值得記的，只回一個字：沒有。',
    '',
    '今天的對話：',
    diaryText.trim(),
  ].join('\n');
}

/**
 * 解析整理结果：`三|他喜欢猫` 这种行，外加 `話題|…` 与 `自己|…`。
 * 不认的行直接丢（模型偶尔会写解释、空行、markdown 列表）。
 */
export function parseConsolidateExtra(text) {
  const entries = [];
  const loops = [];
  let self = '';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*\s]+/, '').trim();
    if (!line) continue;
    const m = /^([一二三四五六七八]|話題|话题|自己)[｜|、.]?\s*[|｜]\s*(.+)$/.exec(line);
    if (m) {
      const body = oneLine(m[2], 300);
      if (!body) continue;
      if (m[1] === '話題' || m[1] === '话题') {
        if (loops.length < 2) loops.push(body);
        continue;
      }
      if (m[1] === '自己') {
        self = body;
        continue;
      }
      if (!CARD_CHAPTERS.has(m[1])) continue;
      entries.push({ chapter: m[1], text: body });
      continue;
    }
    // 模型有时会把「話題」那一段写成本来的题目（`深空當舖|他真去玩了…`）：
    // 左边的标签不是章号、不是「自己」，就当「未聊完的事」，把题目留在正文里。
    const loose = /^([^|｜]{1,8})[|｜]\s*(.+)$/.exec(line);
    if (!loose) continue;
    const label = loose[1].trim();
    if (!label || label === '自己' || label === '話題' || label === '话题') continue;
    const body = oneLine(`${label}：${loose[2]}`, 300);
    if (body && loops.length < 2) loops.push(body);
  }
  return { entries, loops, self };
}

/** 只看记忆卡条目（老接口，保持兼容）。 */
export function parseConsolidate(text) {
  return parseConsolidateExtra(text).entries;
}

function chapterHeading(line) {
  if (!line.startsWith('##')) return '';
  const rest = line.slice(2).trim();
  const num = rest.slice(0, 1);
  if (!'一二三四五六七八'.includes(num)) return '';
  const sep = rest.slice(1, 2).trim();
  if (!'、.｜|·:：-—'.includes(sep)) return '';
  return num;
}

/** 比「是不是说过同一件事」用的：去掉标点空白、压小写。 */
function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(/^[-*\s]+/, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

/** 兩段話的「字元二元組」重疊度；換了語序也能抓到同一件事。 */
function tooSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return false;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / Math.min(ga.size, gb.size) >= 0.6;
}

/** 只看「- 」條目；第一張的普通段落是身份錨點，不參與裁剪。 */
function bulletLinesIn(lines, idxs) {
  return idxs.filter((i) => /^\s*-\s+/.test(lines[i]));
}


/** 一章里最多留几条；超了就从最旧的开始丢，免得整章越滚越长。 */
const MAX_BULLETS_PER_CHAPTER = 12;

function splitChapters(lines) {
  const out = new Map();
  let cur = '';
  for (let i = 0; i < lines.length; i += 1) {
    const num = chapterHeading(lines[i]);
    if (num) {
      cur = num;
      if (!out.has(cur)) out.set(cur, []);
      continue;
    }
    if (!cur) continue;
    if (lines[i].trim()) out.get(cur).push(i);
  }
  return out;
}

/**
 * 把条目追加到记忆卡对应章的末尾（下一章标题之前）。
 * 写之前先备份一份 `記憶卡.md.bak-<时间戳>`；返回 {file, backup, added, skipped, trimmed}。
 * - 同一章里已经说过的话不重复写（只差标点的也算同一条）。
 * - 每章超过 MAX_BULLETS_PER_CHAPTER 条就从最旧的删。
 */
export function appendCardEntries(cardFile, entries, at = new Date()) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && CARD_CHAPTERS.has(e.chapter) && String(e.text ?? '').trim()) : [];
  if (!list.length) return { file: cardFile, backup: '', added: 0, skipped: 0, trimmed: 0 };
  const original = fs.readFileSync(cardFile, 'utf8');
  const stamp = `${dayStamp(at).replace(/-/g, '')}-${clockStamp(at).replace(':', '')}-${String(at.getSeconds()).padStart(2, '0')}`;
  const backup = `${cardFile}.bak-${stamp}`;
  fs.writeFileSync(backup, original, 'utf8');

  const lines = original.split(/\r?\n/);
  let added = 0;
  let skipped = 0;
  for (const entry of list) {
    const text = oneLine(entry.text, 300);
    if (!text) continue;
    const norm = normalizeForCompare(text);
    const chapterLines = splitChapters(lines).get(entry.chapter) ?? [];
    const seen = chapterLines.some((i) => {
      const other = normalizeForCompare(lines[i]);
      if (other === norm) return true;
      if (norm.length > 8 && (other.includes(norm) || norm.includes(other))) return true;
      return norm.length > 20 && tooSimilar(other, norm);
    });
    if (seen) {
      skipped += 1;
      continue;
    }
    // 从后往前找这一章，插到下一章标题前；找不到就追加到文件末尾。
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (chapterHeading(lines[i]) === entry.chapter) {
        start = i;
        break;
      }
    }
    const bullet = `- ${text}`;
    if (start < 0) {
      lines.push('', `## ${entry.chapter}`, bullet);
      added += 1;
      continue;
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (chapterHeading(lines[i])) {
        end = i;
        break;
      }
    }
    // 章末可能有一堆空行，插在最后一个非空行之后，保持段落紧凑。
    let insertAt = end;
    while (insertAt > start + 1 && !lines[insertAt - 1].trim()) insertAt -= 1;
    lines.splice(insertAt, 0, bullet);
    added += 1;
  }

  // 收尾：每章太长就从最旧的删（只删这一章开头的条目）。
  let trimmed = 0;
  for (const [, idxs] of splitChapters(lines)) {
    const bullets = bulletLinesIn(lines, idxs);
    const over = bullets.length - MAX_BULLETS_PER_CHAPTER;
    if (over <= 0) continue;
    const drop = bullets.slice(0, over);
    for (const i of drop.sort((a, b) => b - a)) {
      lines.splice(i, 1);
      trimmed += 1;
    }
  }
  if (!added && !trimmed) return { file: cardFile, backup: '', added: 0, skipped, trimmed: 0 };
  if (!added && trimmed) fs.writeFileSync(backup, original, 'utf8');
  fs.writeFileSync(cardFile, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return { file: cardFile, backup, added, skipped, trimmed };
}

function entryCount(list) {
  return list.length;
}

/** 到了整理时间没有（每天一次，按本地时间的小时数比）。hour < 0 表示关掉。 */
export function shouldConsolidate(state, { hour = 23, now = new Date() } = {}) {
  const at = Number(hour);
  if (!(at >= 0)) return false;
  const today = dayStamp(now);
  if (String(state?.lastConsolidated ?? '') === today) return false;
  return now.getHours() >= at;
}

/**
 * 找出星汐「绑定」里那些不属于这个档案的会话。
 * 拾星会把每个绑定会话的历史都整理进档案，多绑一个就等于多一条人生线。
 * workers 是拾星自己开的工人会话，不算外人。
 */
export function foreignBindings(bindings, { folder = '', sessionId = '', workers = [] } = {}) {
  if (!bindings || typeof bindings !== 'object') return [];
  const mine = String(folder).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const own = new Set([String(sessionId), ...workers.map((id) => String(id))].filter(Boolean));
  const out = [];
  for (const [sid, dir] of Object.entries(bindings)) {
    const target = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!mine || target !== mine) continue;
    if (own.has(String(sid))) continue;
    out.push(String(sid));
  }
  return out;
}

/**
 * 把星汐 config.json 里「不属于这个档案」的绑定摘掉（改之前先备份）。
 * 拾星会把每个绑定会话的历史都整理进档案，混进一条就等于多写一段别人的人生。
 * 顺手把「当前这个会话」绑回去——换过会话以后不绑，档案就悄悄停止生长了。
 * 返回 { removed: [会话id], added: 是否补绑了当前会话, backup: 备份文件路径 }。
 */
export function pruneForeignBindings(configFile, { folder = '', sessionId = '', workers = [] } = {}) {
  const none = { removed: [], added: false, backup: '' };
  if (!configFile) return none;
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return none;
    const key = Object.keys(cfg).find((k) => k === '绑定' || k === 'bindings');
    if (!key || !cfg[key] || typeof cfg[key] !== 'object') return none;
    const removed = foreignBindings(cfg[key], { folder, sessionId, workers });
    // 换过会话之后，新会话也得绑上，否则档案就停止长了（而且没人会报错）。
    const mine = String(folder).replace(/\\/g, '/').replace(/\/+$/, '');
    const already = Boolean(mine) && Boolean(sessionId) && String(cfg[key][sessionId] ?? '').replace(/\\/g, '/').replace(/\/+$/, '') === mine;
    const added = Boolean(mine) && Boolean(sessionId) && !already;
    if (!removed.length && !added) return none;
    const backup = `${configFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(configFile, backup);
    for (const sid of removed) delete cfg[key][sid];
    if (added) cfg[key][sessionId] = folder;
    fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}${String.fromCharCode(10)}`, 'utf8');
    return { removed, added, backup };
  } catch {
    return none;
  }
}

/**
 * 魚の記憶是「按會話開關」的短時記憶，和記憶卡是兩套。lane 只吃記憶卡，
 * 所以每換一次會話都要把新會話在魚の記憶裡關掉——不然它預設是開的，
 * 兩套記憶同時往 prompt 裡塞，說法遲早打架。
 */
export function pinFishMemoryOff(configFile, sessionId) {
  const none = { changed: false, backup: '' };
  if (!configFile || !sessionId) return none;
  try {
    if (!fs.existsSync(configFile)) return none;
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const cfg = parsed && typeof parsed === 'object' ? parsed : {};
    if (!cfg.sessions || typeof cfg.sessions !== 'object') cfg.sessions = {};
    if (cfg.sessions[sessionId] === false) return none;
    const backup = `${configFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(configFile, backup);
    cfg.sessions[sessionId] = false;
    fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    return { changed: true, backup };
  } catch {
    return none;
  }
}
