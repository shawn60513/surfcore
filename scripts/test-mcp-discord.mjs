// 测试 Discord MCP server（src/mcp-discord-safe.js + src/discord-core.js）。
//
// 分两层：
// 1) 离线引擎测试：用假 fetch 验证白名单、发送压制 @everyone、429 重试、正文校验等失败路径，
//    不需要 token、不联网、不真发消息。
// 2) stdio 接入测试：像 DSH 的 dsh-mcp-client 一样拉起 server，握手 + listTools（不调发送类工具）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createDiscordClient,
  loadDiscordConfig,
  sanitizeMessageContent,
  toErrorPayload,
} from '../src/discord-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUILD = '1209805483066789908';
const CHANNEL = '1209805483066789911';
const OTHER_GUILD = '999999999999999999';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** 假 fetch：按 route 回预设响应，并记录每次请求（method/url/body）。 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? 'GET', body, headers: init.headers });
    const result = handler({ url, method: init.method ?? 'GET', body });
    const { status = 200, json = {} } = result ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(json),
    };
  };
  impl.calls = calls;
  return impl;
}

function expectError(name, error, code) {
  const payload = toErrorPayload(error);
  check(name, payload.ok === false && payload.code === code && Boolean(payload.hint), `code=${payload.code}`);
}

const baseCfg = {
  enabled: true,
  allowSend: true,
  guildIds: [GUILD],
  channelIds: [],
  maxReadLimit: 50,
  maxContentLength: 2000,
  requestTimeoutMs: 5000,
  channelCacheTtlMs: 0,
};

// ── 1. 配置默认值 ────────────────────────────────────────────────
const defaults = loadDiscordConfig(path.join(ROOT, '__no_such_dir__'));
check('缺 config 时默认启用且白名单为空（fail-closed）', defaults.enabled === true && defaults.guildIds.length === 0);

// ── 2. 没 token ─────────────────────────────────────────────────
{
  const client = createDiscordClient({ token: '', cfg: baseCfg, fetchImpl: fakeFetch(() => ({})) });
  try {
    await client.me();
    check('无 token 时报错', false);
  } catch (error) {
    expectError('无 token 时报 struct 化错误', error, 'discord.no-token');
  }
}

// ── 3. 白名单为空 → 一律拒绝 ─────────────────────────────────────
{
  const client = createDiscordClient({
    token: 'x',
    cfg: { ...baseCfg, guildIds: [], channelIds: [] },
    fetchImpl: fakeFetch(() => ({ json: { id: CHANNEL, type: 0, guild_id: GUILD } })),
  });
  try {
    await client.readMessages(CHANNEL);
    check('白名单为空时报错', false);
  } catch (error) {
    expectError('白名单为空拒绝读消息', error, 'discord.no-whitelist');
  }
}

// ── 4. 频道不在白名单 ───────────────────────────────────────────
{
  const client = createDiscordClient({
    token: 'x',
    cfg: baseCfg,
    fetchImpl: fakeFetch(({ url }) =>
      url.includes('/channels/')
        ? { json: { id: CHANNEL, type: 0, guild_id: OTHER_GUILD } }
        : { json: [] }
    ),
  });
  try {
    await client.sendMessage(CHANNEL, { content: 'hi' });
    check('白名单外频道报错', false);
  } catch (error) {
    expectError('白名单外频道被拒绝', error, 'discord.channel-not-allowed');
  }
}

// ── 5. 发送：压制 @everyone + body 结构 ──────────────────────────
{
  const fetchImpl = fakeFetch(({ url, method }) => {
    if (method === 'GET' && url.includes('/channels/')) return { json: { id: CHANNEL, type: 0, guild_id: GUILD } };
    return { json: { id: '111111111111111111', content: 'hello @everyone' } };
  });
  const client = createDiscordClient({ token: 'x', cfg: baseCfg, fetchImpl });
  const sent = await client.sendMessage(CHANNEL, { content: 'hello @everyone', replyTo: '222222222222222222' });
  const post = fetchImpl.calls.find((c) => c.method === 'POST');
  check('发送成功返回消息 id', sent.ok === true && sent.id === '111111111111111111');
  check(
    '发送时压制 @everyone/@role',
    post?.body?.allowed_mentions?.parse?.length === 0 && post?.body?.allowed_mentions?.replied_user === false
  );
  check('replyTo 变 message_reference', post?.body?.message_reference?.message_id === '222222222222222222');
  check('请求带 Bot 认证头且不泄漏到返回值', post?.headers?.Authorization === 'Bot x' && !JSON.stringify(sent).includes('Bot x'));
}

// ── 6. allowSend=false → 关闭发送 ───────────────────────────────
{
  const client = createDiscordClient({
    token: 'x',
    cfg: { ...baseCfg, allowSend: false },
    fetchImpl: fakeFetch(() => ({ json: { id: CHANNEL, type: 0, guild_id: GUILD } })),
  });
  try {
    await client.sendMessage(CHANNEL, { content: 'hi' });
    check('allowSend=false 拒绝发送', false);
  } catch (error) {
    expectError('allowSend=false 拒绝发送', error, 'discord.send-disabled');
  }
}

// ── 7. 正文校验 ─────────────────────────────────────────────────
{
  let emptyCode = '';
  try { sanitizeMessageContent('   '); } catch (error) { emptyCode = toErrorPayload(error).code; }
  check('空正文报错', emptyCode === 'discord.empty-content', emptyCode);

  let longCode = '';
  try { sanitizeMessageContent('a'.repeat(2001)); } catch (error) { longCode = toErrorPayload(error).code; }
  check('超长正文报错（不静默截断）', longCode === 'discord.too-long', longCode);

  const cleaned = sanitizeMessageContent('a\u0000b\r\nc ');
  check('控制字符被清除、CRLF 归一', cleaned === 'ab\nc', JSON.stringify(cleaned));
}

// ── 8. 429 重试一次后成功 ───────────────────────────────────────
{
  let hits = 0;
  const fetchImpl = fakeFetch(({ url, method }) => {
    if (method === 'GET' && url.includes('/channels/')) return { json: { id: CHANNEL, type: 0, guild_id: GUILD } };
    hits += 1;
    return hits === 1 ? { status: 429, json: { retry_after: 0.5, message: 'rate limited' } } : { json: { id: '333333333333333333' } };
  });
  const client = createDiscordClient({ token: 'x', cfg: baseCfg, fetchImpl, sleep: async () => {} });
  const sent = await client.sendMessage(CHANNEL, { content: 'retry me' });
  check('429 自动重试一次后成功', hits === 2 && sent.id === '333333333333333333', `hits=${hits}`);
}

// ── 9. 读消息按时间正序 ─────────────────────────────────────────
{
  const fetchImpl = fakeFetch(({ url }) => {
    if (url.includes('/messages')) {
      return {
        json: [
          { id: '3', content: '第三条', author: { id: '1', username: 'a' } },
          { id: '2', content: '第二条', author: { id: '1', username: 'a' } },
          { id: '1', content: '第一条', author: { id: '1', username: 'a' } },
        ],
      };
    }
    return { json: { id: CHANNEL, type: 0, guild_id: GUILD } };
  });
  const client = createDiscordClient({ token: 'x', cfg: baseCfg, fetchImpl });
  const list = await client.readMessages(CHANNEL, { limit: 10 });
  check('读消息翻成时间正序', list.map((m) => m.id).join(',') === '1,2,3', list.map((m) => m.id).join(','));
  check('limit 出现在查询串', fetchImpl.calls.some((c) => c.url.includes('limit=10')));
}

// ── 10. stdio 接入（像 DSH 的 dsh-mcp-client）────────────────────
{
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp-discord-safe.js')],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'discord-mcp-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ['discord_add_reaction', 'discord_edit_message', 'discord_list_channels', 'discord_read_messages', 'discord_send_message', 'discord_status'];
    check('stdio 握手 + 六个工具齐全', JSON.stringify(names) === JSON.stringify(expected), names.join(','));
  } catch (error) {
    const message = String(error?.message ?? error);
    // DSH 的 Windows 沙箱禁止「用管道抓子进程输出」（EPERM）。这是环境边界，不是代码缺陷：
    // 在能起子进程的环境（用户自己的 shell / CI）里这条会真的跑；沙箱里明确跳过并说出来。
    if (/EPERM/.test(message)) {
      console.log('⚠️ 跳过 stdio 子进程测试：当前沙箱禁止 pipe spawn（EPERM），在普通 shell 里重跑本脚本可验证');
    } else {
      check(`stdio 接入失败：${message}`, false);
    }
  } finally {
    try { await client.close(); } catch {}
  }
}

console.log(failures === 0 ? '\nDiscord MCP 测试全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
