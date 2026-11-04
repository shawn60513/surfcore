// Discord MCP server（stdio）。由 DSH 的 MCP 客户端 spawn，工具名在会话里是
// `mcp__discord__<name>`。
//
// 目的：跟 SnowLuma 连 QQ 一样，让我在**一轮对话里**直接读/发 Discord，
// 而不是把会话搬到 Discord（那是 @addozhang/dsh-discord 适配器干的事）。
//
// 安全边界：
// - 只走 REST（不抢 gateway），token 从 DSH 凭据读，不打印、不回显；
// - 服务器/频道白名单在 discord-core.js 里强制，白名单外一律拒绝；
// - 发送一律压制 @everyone/@role/@user 的 ping；
// - 每个失败都回 `{ ok:false, code, error, hint }`，让模型知道下一步怎么做。
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  createDiscordClient,
  loadDiscordConfig,
  resolveDiscordToken,
  toErrorPayload,
  DiscordError,
} from './discord-core.js';

/** 项目根目录：不能用 import.meta.url（离线测试会在 vm 里执行本文件）。同 mcp-web-search-safe.js。 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

const root = projectRoot();
const cfg = loadDiscordConfig(root);
const { token, source } = resolveDiscordToken(cfg);
const client = createDiscordClient({ token, cfg });

const server = new McpServer({ name: 'discord', version: '0.1.0' });

function text(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** 统一出口：成功回数据，失败回结构化错误（1.7：看得见 + 给下一步）。 */
async function run(fn) {
  if (!cfg.enabled) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: false,
              code: 'discord.disabled',
              error: 'config.json 里 discord.enabled=false，Discord 工具已关闭',
              hint: '把 config.json 的 discord.enabled 改成 true 后重启 DSH',
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  try {
    return text(await fn());
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify(toErrorPayload(error), null, 2) }], isError: true };
  }
}

server.tool(
  'discord_status',
  'Discord 连接自检：返回 bot 身份、token 来源、白名单服务器数量、发送开关。只读，不发送任何消息。',
  {},
  async () =>
    run(async () => {
      if (!token) {
        throw new DiscordError(
          'discord.no-token',
          '拿不到 Discord bot token',
          '在 DSH 凭据里写入 DSH_DISCORD_BOT_TOKEN（设置 → 凭据 / 或 ~/.dsh/.credentials.yaml 的 refs），再重试'
        );
      }
      const me = await client.me();
      const guilds = await client.guilds().catch(() => []);
      return {
        ok: true,
        bot: {
          id: String(me?.id ?? ''),
          username: String(me?.username ?? ''),
          globalName: me?.global_name ?? null,
          bot: Boolean(me?.bot),
        },
        tokenSource: source,
        enabled: cfg.enabled,
        allowSend: cfg.allowSend,
        whitelistedGuilds: cfg.guildIds,
        whitelistedChannels: cfg.channelIds,
        visibleGuilds: (Array.isArray(guilds) ? guilds : []).map((g) => ({ id: String(g.id), name: String(g.name ?? '') })),
      };
    })
);

server.tool(
  'discord_list_channels',
  '列出白名单服务器里可发文本的频道（id + 名称）。只读。发消息前先用它找频道 ID。',
  {},
  async () =>
    run(async () => {
      const guilds = await client.listChannels();
      return { ok: true, guilds };
    })
);

server.tool(
  'discord_read_messages',
  '读某个 Discord 文本频道最近的聊天记录（按时间正序）。只读；需要频道在白名单内。',
  {
    channel: z.string().describe('频道 ID（数字），先用 discord_list_channels 查'),
    limit: z.number().int().min(1).max(100).optional().describe('最多取多少条，默认 20'),
    before: z.string().optional().describe('只取这条消息 ID 之前的记录（翻页用）'),
  },
  async ({ channel, limit, before }) =>
    run(async () => {
      const messages = await client.readMessages(channel, { limit, before });
      return { ok: true, channel: String(channel), count: messages.length, messages };
    })
);

server.tool(
  'discord_send_message',
  '在 Discord 文本频道发一条消息（可指定 replyTo 引用某条消息）。会压制 @everyone/@role 的 ping。这是对外发送操作。',
  {
    channel: z.string().describe('频道 ID（数字），必须在白名单服务器里'),
    content: z.string().describe('消息正文，最多 2000 字符，纯文本（Discord markdown 可用）'),
    replyTo: z.string().optional().describe('要引用/回复的消息 ID（来自 discord_read_messages）'),
  },
  async ({ channel, content, replyTo }) =>
    run(async () => client.sendMessage(channel, { content, replyTo }))
);

server.tool(
  'discord_edit_message',
  '编辑 bot 自己发过的消息（别人的消息 Discord 不允许编辑）。只能改正文。',
  {
    channel: z.string().describe('频道 ID'),
    messageId: z.string().describe('要编辑的消息 ID（必须是 bot 自己发的）'),
    content: z.string().describe('新的正文，最多 2000 字符'),
  },
  async ({ channel, messageId, content }) =>
    run(async () => client.editMessage(channel, messageId, { content }))
);

server.tool(
  'discord_add_reaction',
  '给某条消息加一个表情回应（反应）。轻量、可撤回，适合"表示看到了"。',
  {
    channel: z.string().describe('频道 ID'),
    messageId: z.string().describe('消息 ID'),
    emoji: z.string().describe('unicode 表情，如 ✅ 或 👍'),
  },
  async ({ channel, messageId, emoji }) =>
    run(async () => client.addReaction(channel, messageId, emoji))
);

await server.connect(new StdioServerTransport());
