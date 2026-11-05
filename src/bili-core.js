/**
 * B 站只读/关注引擎（给 MCP 用，纯逻辑、可离线测试）。
 *
 * 为什么单独写一份，而不是复用 dsh-bili-subagent 里的 python MCP：
 *   - 那个插件在 node_modules 里，升级就被覆盖；这里的工具要长期可用。
 *   - 现在缺的就是「看关注名单」「看 @ 我」「去关注/取关」这三件，python 侧只做了前一半。
 *
 * 设计：只碰 REST（credential 里的 cookie），不碰 gateway；所有对外动作（关注/取关）
 * 默认关着，要显式在 config.json 里 allowFollow:true 才放行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BILI_API = 'https://api.bilibili.com';
export const DEFAULT_CREDENTIAL_PATH = path.join(os.homedir(), '.dsh', 'bili-duty', 'bili_credential.json');
export const MENTION_KINDS = ['at', 'reply', 'like'];

export class BiliError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.hint = hint;
  }
}

export function toErrorPayload(error) {
  if (error instanceof BiliError) {
    return { ok: false, code: error.code, error: error.message, hint: error.hint };
  }
  return { ok: false, code: 'bili.unknown', error: String(error?.message ?? error), hint: '' };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 读 config.json 的 bili 段（缺省值全部保守：不开、不写）。 */
export function loadBiliConfig(root) {
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  } catch {
    doc = {};
  }
  const cfg = doc.bili && typeof doc.bili === 'object' ? doc.bili : {};
  return {
    enabled: cfg.enabled !== false,
    credentialPath: typeof cfg.credentialPath === 'string' && cfg.credentialPath.trim()
      ? cfg.credentialPath.trim()
      : DEFAULT_CREDENTIAL_PATH,
    allowFollow: cfg.allowFollow === true,
    requestTimeoutMs: clampInt(cfg.requestTimeoutMs, 15000, 3000, 60000),
    maxItems: clampInt(cfg.maxItems, 30, 1, 100),
  };
}

/** 读扫码登录落盘的凭证；缺一个字段就当没登录，别拿半张 cookie 去撞接口。 */
export function readCredential(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new BiliError('bili.no-credential', `找不到 B站 凭证：${file}`, '先在「刷B站」设置页扫码登录');
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new BiliError('bili.bad-credential', `B站 凭证不是合法 JSON：${file}`, '重新扫码登录一次');
  }
  const cred = {
    sessdata: String(doc.sessdata ?? ''),
    bili_jct: String(doc.bili_jct ?? ''),
    buvid3: String(doc.buvid3 ?? ''),
    dedeuserid: String(doc.dedeuserid ?? doc.DedeUserID ?? ''),
  };
  if (!cred.sessdata || !cred.bili_jct) {
    throw new BiliError('bili.no-credential', 'B站 凭证缺少 SESSDATA / bili_jct', '重新扫码登录一次');
  }
  return cred;
}

export function cookieHeader(cred) {
  return `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`;
}

/**
 * 打一次 B站 接口。
 * - 网络层错误 → bili.network
 * - HTTP 非 200 → bili.http-<status>
 * - 业务 code !== 0 → bili.api-<code>（B站 的 -101 是没登录、-352 是风控）
 */
export async function biliRequest({
  cred,
  pathname,
  query,
  method = 'GET',
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  if (!cred?.sessdata) throw new BiliError('bili.no-credential', '没有可用的 B站 凭证', '先扫码登录');
  const url = new URL(pathname.startsWith('http') ? pathname : `${BILI_API}${pathname}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const headers = {
    cookie: cookieHeader(cred),
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    referer: 'https://www.bilibili.com/',
  };
  if (method !== 'GET') headers['content-type'] = 'application/x-www-form-urlencoded';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    throw new BiliError('bili.network', `连不上 B站：${error?.message ?? error}`, '检查网络/代理');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new BiliError(`bili.http-${res.status}`, `B站 返回 HTTP ${res.status}`, '稍后再试');
  const text = await res.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new BiliError('bili.bad-response', 'B站 返回的不是 JSON（可能被风控拦了）', '稍后再试，或重新扫码登录');
  }
  if (doc.code !== 0) {
    const code = `bili.api-${doc.code}`;
    const hint = doc.code === -101 ? '登录态失效，重新扫码登录' : doc.code === -352 ? '触发风控，先隔一会儿再试' : '';
    throw new BiliError(code, `B站 接口报错：${doc.message ?? doc.code}`, hint);
  }
  return doc;
}

export function normalizeUser(u = {}) {
  return {
    uid: String(u.mid ?? u.uid ?? ''),
    name: String(u.uname ?? u.nickname ?? u.name ?? ''),
    sign: String(u.sign ?? ''),
    face: String(u.face ?? ''),
  };
}

/** 关注列表里的一项（/x/relation/followings 的 list 元素）。 */
export function normalizeFollowing(u = {}) {
  return {
    uid: String(u.mid ?? ''),
    name: String(u.uname ?? u.nickname ?? ''),
    sign: String(u.sign ?? ''),
    official: String(u.official_verify?.title ?? ''),
  };
}

/** 消息中心（@ 我 / 回复我 / 点赞我）的一条。 */
export function normalizeMention(kind, item = {}) {
  const user = normalizeUser(item.user ?? {});
  const content = item.item ?? {};
  return {
    kind,
    id: String(content.id ?? item.id ?? ''),
    user: user.name,
    uid: user.uid,
    // title 是「在哪条内容下面」；text 才是对方真正说的话（B站 把它放在 source_content）。
    title: String(content.title ?? '').trim(),
    text: String(content.source_content ?? content.content ?? '').trim(),
    type: String(content.type ?? ''),
    url: String(content.uri ?? content.native_uri ?? ''),
    at: Number(item.at_time ?? item.timestamp ?? 0) || null,
  };
}

export function createBiliClient({ cred, cfg = {}, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  const request = (opts) => biliRequest({
    cred,
    fetchImpl,
    timeoutMs: timeoutMs ?? cfg.requestTimeoutMs ?? 15000,
    ...opts,
  });

  async function me() {
    const doc = await request({ pathname: '/x/web-interface/nav' });
    const d = doc.data ?? {};
    return {
      uid: String(d.mid ?? cred.dedeuserid ?? ''),
      name: String(d.uname ?? ''),
      loggedIn: d.isLogin === true,
      coins: d.money ?? null,
      level: d.level_info?.current_level ?? null,
      following: d.following ?? null,
      follower: d.follower ?? null,
    };
  }

  async function followings({ page = 1, limit } = {}) {
    const meDoc = await me();
    const ps = clampInt(limit ?? cfg.maxItems, 30, 1, 50);
    const doc = await request({
      pathname: '/x/relation/followings',
      query: { vmid: meDoc.uid, pn: clampInt(page, 1, 1, 1000), ps, order: 'desc' },
    });
    const data = doc.data ?? {};
    return {
      total: Number(data.total ?? 0) || 0,
      page: Number(data.page ?? page) || page,
      items: (data.list ?? []).map(normalizeFollowing).filter((x) => x.uid),
    };
  }

  async function mentions({ kind = 'at', limit } = {}) {
    const k = MENTION_KINDS.includes(kind) ? kind : 'at';
    const doc = await request({
      pathname: `/x/msgfeed/${k}`,
      query: { build: 0, mobi_app: 'web' },
    });
    const raw = doc.data?.items ?? [];
    const max = clampInt(limit ?? cfg.maxItems, 30, 1, 100);
    return {
      kind: k,
      total: Number(doc.data?.total ?? raw.length) || raw.length,
      items: raw.slice(0, max).map((x) => normalizeMention(k, x)),
    };
  }

  /** 关注 / 取关。默认关着，cfg.allowFollow 才放行 —— 这是对外动作。 */
  async function follow({ uid, action = 'follow' } = {}) {
    if (cfg.allowFollow !== true) {
      throw new BiliError('bili.follow-disabled', '关注/取关没开', '在 config.json 的 bili.allowFollow 设 true');
    }
    const target = String(uid ?? '').trim();
    if (!/^\d{1,20}$/.test(target)) throw new BiliError('bili.bad-uid', 'uid 必须是数字', '填 B站 的 UID');
    const act = action === 'unfollow' ? 2 : 1;
    const doc = await request({
      method: 'POST',
      pathname: '/x/relation/modify',
      body: { fid: target, act, re_src: 11, csrf: cred.bili_jct },
    });
    return { ok: true, uid: target, action: act === 2 ? 'unfollow' : 'follow', raw: doc.code };
  }

  return { request, me, followings, mentions, follow };
}
