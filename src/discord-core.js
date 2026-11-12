// Discord 引擎（纯逻辑，不依赖 MCP）：给 mcp-discord-safe.js 用，也方便离线测试。
//
// 设计约束（为什么这么写）：
// - **只走 REST，不建 gateway 连接**。同一个 bot token 可能已经被 dsh-discord 适配器
//   占着 gateway；本引擎只发 HTTP，不抢事件流，两者可共存。
// - **默认 fail-closed**：`config.json` 的 `discord.guildIds` 为空时，任何频道访问都拒绝。
//   读消息、发消息必须先过「频道 → 所属服务器」白名单（GET /channels/{id} 反查，缓存 2 分钟）。
// - **token 只在本模块出现一次**：不写日志、不进错误文案。凭据来源：config.token →
//   env[credentialRef] → DSH 的 `~/.dsh/.credentials.yaml`。
// - **@everyone/@role 一律压制**：每条发送都带 `allowed_mentions.parse = []`，
//   文本里的 @ 只是字符，不会真的 ping 人。
// - **失败可见**：所有失败统一 `DiscordError{code,message,hint}`，MCP 层原样回成
//   `{ ok:false, code, error, hint }`，让模型看到「哪一步、下一步做什么」。
import fs from 'node:fs';
import path from 'node:path';
import { readDshCredential } from './web-search.js';

export const DISCORD_API = 'https://discord.com/api/v10';
export const DEFAULT_CREDENTIAL_REF = 'DSH_DISCORD_BOT_TOKEN';

/** 结构化失败：code 给机器，message 给人，hint 给下一步。 */
export class DiscordError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'DiscordError';
    this.code = code;
    this.hint = hint;
  }
}

export function toErrorPayload(error) {
  if (error instanceof DiscordError) {
    return { ok: false, code: error.code, error: error.message, hint: error.hint };
  }
  return {
    ok: false,
    code: 'discord.unexpected',
    error: String(error?.message ?? error),
    hint: '重试一次；持续失败就把 Discord 工具关掉（config.json 的 discord.enabled=false）并看 MCP 日志',
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeIds(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((v) => String(v ?? '').trim()).filter((v) => /^\d{5,25}$/.test(v)))];
}

/**
 * 读 config.json 的 `discord` 段。缺文件/坏 JSON 时按默认值（fail-closed：白名单为空）。
 */
export function loadDiscordConfig(root) {
  let raw = {};
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    if (doc && typeof doc.discord === 'object' && doc.discord) raw = doc.discord;
  } catch {
    raw = {};
  }
  const ref = String(raw.credentialRef ?? '').trim();
  return {
    enabled: raw.enabled !== false,
    credentialRef: /^[A-Z][A-Z0-9_]*$/.test(ref) ? ref : DEFAULT_CREDENTIAL_REF,
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    guildIds: normalizeIds(raw.guildIds),
    channelIds: normalizeIds(raw.channelIds),
    allowSend: raw.allowSend !== false,
    mentionUsers: normalizeIds(raw.mentionUsers),
    allowDm: raw.allowDm === true,
    pingOnReply: raw.pingOnReply !== false,
    maxReadLimit: clampInt(raw.maxReadLimit, 50, 1, 100),
    maxContentLength: clampInt(raw.maxContentLength, 2000, 1, 2000),
    requestTimeoutMs: clampInt(raw.requestTimeoutMs, 15000, 3000, 60000),
    channelCacheTtlMs: clampInt(raw.channelCacheTtlMs, 120000, 0, 3600000),
  };
}

/** token 来源链：config 明文（不推荐）→ 环境变量 → DSH 凭据文件。返回值里 source 只用于状态展示。 */
export function resolveDiscordToken(cfg, env = process.env) {
  if (cfg?.token) return { token: cfg.token, source: 'config' };
  const ref = cfg?.credentialRef || DEFAULT_CREDENTIAL_REF;
  const fromEnv = String(env?.[ref] ?? '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(ref);
  if (fromDsh) return { token: fromDsh, source: 'dsh-credentials' };
  return { token: '', source: 'none' };
}

function hintForStatus(status, body) {
  if (status === 401) return 'Bot token 无效或已被重置：去 DSH 凭据里更新 DSH_DISCORD_BOT_TOKEN';
  if (status === 403) return 'Bot 缺权限：至少需要 查看频道 / 读取消息历史 / 发送消息';
  if (status === 404) return '频道或消息不存在，或 Bot 看不到它：核对 ID，并确认 Bot 已被邀进该服务器且频道对它可见';
  if (status === 429) return '被 Discord 限流：等 retry_after 秒后重试，别连发';
  const detail = typeof body === 'object' && body?.message ? `（${body.message}）` : '';
  return `Discord 返回 HTTP ${status}${detail}；先核对 ID 与 Bot 权限，再重试`;
}

/**
 * 上傳附件（語音、圖片）。Discord 收 multipart/form-data：`payload_json` + `files[0]`。
 * 純 REST，跟 discordRequest 一樣只重試一次 429。
 */
export async function discordUpload({
  token,
  route,
  payload,
  file,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  sleep = defaultSleep,
}) {
  if (!token) {
    throw new DiscordError('discord.no-token', '拿不到 Discord bot token', '在凭据服务写入 DSH_DISCORD_BOT_TOKEN');
  }
  if (!file?.data?.length) {
    throw new DiscordError('discord.no-file', '要上传的文件是空的', '检查刚生成的音频/图片');
  }
  const url = route.startsWith('http') ? route : `${DISCORD_API}${route}`;
  const build = () => {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload ?? {}));
    form.append(
      'files[0]',
      new Blob([file.data], { type: file.contentType || 'application/octet-stream' }),
      file.name || 'file',
    );
    return form;
  };

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (surfcore, 0.8)' },
        body: build(),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      throw new DiscordError('discord.network', `连不上 Discord：${error?.message ?? error}`, '检查网络/代理');
    }
    const text = await response.text();
    if (response.status === 429 && attempt === 0) {
      let retryAfter = 1;
      try { retryAfter = Number(JSON.parse(text)?.retry_after ?? 1); } catch {}
      await sleep(Math.min(5000, Math.max(500, retryAfter * 1000)));
      continue;
    }
    if (!response.ok) {
      throw new DiscordError(`discord.http-${response.status}`, `Discord 返回 HTTP ${response.status}：${text.slice(0, 200)}`, '先核对频道 ID 与 Bot 权限');
    }
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 调一次 Discord REST。成功返回解析后的 body；失败抛 DiscordError。
 * 429 只自动重试一次（retry_after ≤ 5s），避免把限流拖成雪崩。
 */
export async function discordRequest({
  token,
  method = 'GET',
  route,
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  sleep = defaultSleep,
  retries = 1,
}) {
  if (!token) {
    throw new DiscordError(
      'discord.no-token',
      '拿不到 Discord bot token',
      '在 DSH 凭据服务里写入 DSH_DISCORD_BOT_TOKEN（或设同名环境变量），再重试'
    );
  }
  const url = route.startsWith('http') ? route : `${DISCORD_API}${route}`;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'DiscordBot (surfcore, 0.8)',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      throw new DiscordError(
        'discord.network',
        `连不上 Discord：${error?.message ?? error}`,
        '检查本机网络/代理；Discord API 需要直连或可用代理'
      );
    }
    const text = await response.text().catch(() => '');
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 400) };
    }
    if (response.ok) return data;
    if (response.status === 429 && attempt < retries) {
      const waitMs = Math.min(5000, Math.max(500, Number(data?.retry_after ?? 1) * 1000));
      await sleep(waitMs);
      continue;
    }
    const snippet = typeof data?.message === 'string' ? data.message : text.slice(0, 200);
    throw new DiscordError(
      `discord.http-${response.status}`,
      `Discord ${method} ${route} 失败（HTTP ${response.status}）：${snippet || '无正文'}`,
      hintForStatus(response.status, data)
    );
  }
}

/** 归一化一条 Discord 消息，避免把原始 JSON（含大量空字段）直接灌给模型。 */
/**
 * 组装 allowed_mentions：parse 恒为空（压死 @everyone/@role），
 * users 只放行白名单 discord.mentionUsers 里出现的 ID；回复时可选 ping 被回复者。
 */
export function allowedMentionsFor(cfg, mentions, isReply = false) {
  const allowed = new Set(cfg?.mentionUsers ?? []);
  const users = [...new Set((Array.isArray(mentions) ? mentions : []).map(String).filter((id) => allowed.has(id)))];
  const payload = { parse: [] };
  if (users.length) payload.users = users;
  if (isReply && cfg?.pingOnReply !== false) payload.replied_user = true;
  return payload;
}

export function normalizeMessage(message, { maxContent = 1500 } = {}) {
  const content = String(message?.content ?? '');
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const parts = [];
  if (content.trim()) parts.push(content.length > maxContent ? `${content.slice(0, maxContent)}…` : content);
  for (const file of attachments.slice(0, 5)) {
    parts.push(`[附件 ${file.filename ?? '?'} ${file.size ?? '?'}B ${file.content_type ?? ''}]`.trim());
  }
  const embeds = Array.isArray(message?.embeds) ? message.embeds.length : 0;
  if (embeds) parts.push(`[嵌入 ${embeds} 条]`);
  return {
    id: String(message?.id ?? ''),
    author: String(message?.author?.global_name || message?.author?.username || message?.author?.id || 'unknown'),
    authorId: String(message?.author?.id ?? ''),
    bot: Boolean(message?.author?.bot),
    timestamp: String(message?.timestamp ?? ''),
    replyTo: message?.message_reference?.message_id ? String(message.message_reference.message_id) : null,
    edited: Boolean(message?.edited_timestamp),
    content: parts.join('\n').trim(),
    attachments: attachments.slice(0, 5).map((file) => ({
      id: String(file?.id ?? ''),
      filename: String(file?.filename ?? ''),
      contentType: String(file?.content_type ?? ''),
      size: Number(file?.size ?? 0),
      url: String(file?.url ?? ''),
    })),
  };
}

/** 正文清洗：去控制字符、首尾空白；空内容与超长直接报错（不静默截断，免得发出半句话）。 */
export function sanitizeMessageContent(text, maxLength = 2000) {
  const cleaned = String(text ?? '')
    .replace(/\r\n/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!cleaned) throw new DiscordError('discord.empty-content', '消息内容为空', '传非空的 content');
  if (cleaned.length > maxLength) {
    throw new DiscordError(
      'discord.too-long',
      `消息 ${cleaned.length} 字符，超过上限 ${maxLength}`,
      '拆成多条（discord_send_message 每条 ≤2000 字符），或先精简'
    );
  }
  return cleaned;
}

/**
 * 把長文字切成 Discord 單條上限以內的幾段（盡量斷在空行、換行、句號）。
 * 只切一刀都捨不得的情況（連續 2000 字沒標點）才硬切；硬切時避開拆壞 emoji。
 */
export function splitMessage(text, maxLength = 2000) {
  const cleaned = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  const max = Math.max(1, Math.trunc(maxLength));
  if (cleaned.length <= max) return [cleaned];
  const out = [];
  let rest = cleaned;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let end = head.lastIndexOf('\n\n');
    if (end < max * 0.4) end = head.lastIndexOf('\n');
    if (end < max * 0.4) {
      end = Math.max(
        head.lastIndexOf('。'),
        head.lastIndexOf('！'),
        head.lastIndexOf('？'),
        head.lastIndexOf('…'),
        head.lastIndexOf('，'),
      );
    }
    // 找到標點就把標點留在前一段；什麼都沒有才硬切。
    if (end >= max * 0.4) end += 1;
    else end = max;
    // 硬切別把代理對拆成兩半（emoji 會變亂碼）
    const code = rest.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    if (end <= 0) end = max;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** 文本 / 私聊(1) / 群组私聊(3) / 公告 / 公告子区(10) / 公开子区(11) / 私密子区(12) / 论坛 / 论坛子区(15,16) */
const TEXT_CHANNEL_TYPES = new Set([0, 1, 3, 5, 10, 11, 12, 15, 16]);
const DM_CHANNEL_TYPES = new Set([1, 3]);

/**
 * 建一个 Discord 客户端：频道解析 + 白名单校验 + 常用动作。
 * fetchImpl/sleep/now 可注入，测试不用真网络。
 */
export function createDiscordClient({ token, cfg, fetchImpl, timeoutMs, sleep, now = () => Date.now() } = {}) {
  const channelCache = new Map();
  const request = (method, route, body) =>
    discordRequest({ token, method, route, body, fetchImpl, timeoutMs: timeoutMs ?? cfg?.requestTimeoutMs, sleep });

  async function getChannel(channelId) {
    const id = String(channelId ?? '').trim();
    if (!/^\d{5,25}$/.test(id)) {
      throw new DiscordError('discord.bad-channel', `频道 ID 不合法：${id || '(空)'}`, '传纯数字频道 ID，例如 123456789012345678');
    }
    const cached = channelCache.get(id);
    if (cached && now() - cached.at < (cfg?.channelCacheTtlMs ?? 120000)) return cached.channel;
    const channel = await request('GET', `/channels/${id}`);
    channelCache.set(id, { at: now(), channel });
    return channel;
  }

  /** 白名单：频道显式列出即可用；否则必须属于 guildIds 里的服务器。 */
  async function requireAllowedChannel(channelId) {
    if (!cfg?.guildIds?.length && !cfg?.channelIds?.length) {
      throw new DiscordError(
        'discord.no-whitelist',
        'Discord 白名单为空，已拒绝访问',
        '在 config.json 的 discord.guildIds 写入允许的服务器 ID（Discord 开发者模式 → 右键服务器 → 复制服务器 ID）'
      );
    }
    const channel = await getChannel(channelId);
    if (!TEXT_CHANNEL_TYPES.has(Number(channel?.type))) {
      throw new DiscordError(
        'discord.not-text-channel',
        `频道 ${channelId} 不是可发文本的频道（type=${channel?.type}）`,
        '用 discord_list_channels 找一个文本频道再试'
      );
    }
    // 私聊没有 guild_id，靠单独开关放行（默认关：DM 里发消息不经过服务器白名单，风险更高）。
    if (DM_CHANNEL_TYPES.has(Number(channel?.type))) {
      if (cfg?.allowDm === true) return channel;
      throw new DiscordError(
        'discord.dm-disabled',
        `频道 ${channelId} 是私聊，当前 dm 未开启`,
        '确认要把工具接到私聊，就把 config.json 的 discord.allowDm 改成 true'
      );
    }
    const guildId = String(channel?.guild_id ?? '');
    const allowed = cfg.channelIds.includes(String(channelId)) || cfg.guildIds.includes(guildId);
    if (!allowed) {
      throw new DiscordError(
        'discord.channel-not-allowed',
        `频道 ${channelId}（服务器 ${guildId || '未知'}）不在白名单里`,
        '把它所在的服务器加进 discord.guildIds，或把频道 ID 加进 discord.channelIds'
      );
    }
    return channel;
  }

  return {
    request,
    getChannel,
    requireAllowedChannel,

    me: () => request('GET', '/users/@me'),
    guilds: () => request('GET', '/users/@me/guilds'),

    async listChannels() {
      const guilds = await request('GET', '/users/@me/guilds');
      const allowed = new Map();
      for (const guild of Array.isArray(guilds) ? guilds : []) {
        if (!cfg.guildIds.includes(String(guild.id))) continue;
        const channels = await request('GET', `/guilds/${guild.id}/channels`);
        allowed.set(String(guild.id), {
          id: String(guild.id),
          name: String(guild.name ?? ''),
          channels: (Array.isArray(channels) ? channels : [])
            .filter((c) => TEXT_CHANNEL_TYPES.has(Number(c.type)))
            .map((c) => ({ id: String(c.id), name: String(c.name ?? ''), type: Number(c.type) })),
        });
      }
      return [...allowed.values()];
    },

    async readMessages(channelId, { limit = 20, before } = {}) {
      await requireAllowedChannel(channelId);
      const n = clampInt(limit, 20, 1, cfg.maxReadLimit);
      const query = new URLSearchParams({ limit: String(n) });
      if (before) query.set('before', String(before));
      const raw = await request('GET', `/channels/${channelId}/messages?${query.toString()}`);
      const list = Array.isArray(raw) ? raw : [];
      // Discord 返回最新在前；翻成时间顺序，读起来像聊天记录。
      return list.slice().reverse().map((m) => normalizeMessage(m));
    },

    async sendMessage(channelId, { content, replyTo, mentions, file } = {}) {
      if (!cfg.allowSend) {
        throw new DiscordError('discord.send-disabled', 'discord.allowSend=false，发送已关闭', '在 config.json 把 discord.allowSend 设为 true 再试');
      }
      await requireAllowedChannel(channelId);
      // 只有附件、没有文字也可以发（語音就是這樣）。
      // 純文字超過單條上限時自動拆成幾條——不然 lane 那段會整段送不出去、直接被丟掉。
      const pieces = file
        ? [String(content ?? '').slice(0, cfg.maxContentLength)]
        : splitMessage(content, cfg.maxContentLength).map((piece) => sanitizeMessageContent(piece, cfg.maxContentLength));
      if (!pieces.length) sanitizeMessageContent(content, cfg.maxContentLength);
      const ids = [];
      for (let i = 0; i < pieces.length; i += 1) {
        const text = pieces[i];
        const body = {
          content: text,
          // @everyone / @role 永远压制；只有 discord.mentionUsers 白名单里的 ID 会真的 ping 到人。
          allowed_mentions: allowedMentionsFor(cfg, mentions, Boolean(replyTo) && i === 0),
        };
        // 引用只掛在第一條上，拆出來的其他段當成後續訊息。
        if (replyTo && i === 0) body.message_reference = { message_id: String(replyTo), fail_if_not_exists: false };
        const sent = file
          ? await discordUpload({
            token,
            route: `/channels/${channelId}/messages`,
            payload: body,
            file,
            fetchImpl,
            timeoutMs: Math.max(Number(cfg.requestTimeoutMs) || 15000, 30000),
          })
          : await request('POST', `/channels/${channelId}/messages`, body);
        ids.push(String(sent?.id ?? ''));
      }
      return {
        ok: true,
        id: ids.at(-1) ?? '',
        ids,
        parts: ids.length,
        channelId: String(channelId),
        replyTo: replyTo ? String(replyTo) : null,
        preview: String(pieces[0]).slice(0, 200),
      };
    },

    async editMessage(channelId, messageId, { content, mentions } = {}) {
      await requireAllowedChannel(channelId);
      if (!/^\d{5,25}$/.test(String(messageId ?? ''))) {
        throw new DiscordError('discord.bad-message', `消息 ID 不合法：${messageId}`, '用 discord_read_messages 返回的 id');
      }
      const text = sanitizeMessageContent(content, cfg.maxContentLength);
      const updated = await request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
        content: text,
        allowed_mentions: allowedMentionsFor(cfg, mentions, false),
      });
      return { ok: true, id: String(updated?.id ?? messageId), edited: true };
    },

    async addReaction(channelId, messageId, emoji) {
      await requireAllowedChannel(channelId);
      const name = String(emoji ?? '').trim();
      if (!name) throw new DiscordError('discord.bad-emoji', 'emoji 为空', '传一个 unicode 表情（如 ✅）或 name:id 形式');
      const encoded = encodeURIComponent(name);
      await request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`);
      return { ok: true, channelId, messageId: String(messageId), emoji: name };
    },
  };
}
