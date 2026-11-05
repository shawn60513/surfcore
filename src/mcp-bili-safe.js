// B站 工具 MCP server（stdio）。会话里的工具名是 `mcp__bili-safe__<name>`。
//
// 补齐 dsh-bili-subagent 没暴露出来的三件事：
//   - 看「小愛」（舜的大肥魚）关注了谁；
//   - 看谁 @ 了她 / 回了她 / 点了赞；
//   - 关注 / 取关（对外动作，默认关着，config.json 的 bili.allowFollow 才放行）。
//
// 安全边界：只走 REST，凭证从 ~/.dsh/bili-duty/bili_credential.json 现读现用
// （重新扫码后立刻生效，不用重启 DSH），cookie 不回显、不进错误信息。
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  BiliError,
  createBiliClient,
  loadBiliConfig,
  readCredential,
  toErrorPayload,
} from './bili-core.js';

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
const cfg = loadBiliConfig(root);

const server = new McpServer({ name: 'bili-safe', version: '0.1.0' });

function text(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** 每次调用现读凭证：扫码登录后不必重启 DSH。 */
function client() {
  const cred = readCredential(cfg.credentialPath);
  return { client: createBiliClient({ cred, cfg }), cred };
}

/** 统一出口：成功回数据，失败回结构化错误（看得见 + 给下一步）。 */
async function run(fn) {
  if (!cfg.enabled) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: false,
              code: 'bili.disabled',
              error: 'config.json 里 bili.enabled=false，B站 工具已关闭',
              hint: '把 config.json 的 bili.enabled 改成 true 后重启 DSH',
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
    if (error instanceof BiliError) {
      return { content: [{ type: 'text', text: JSON.stringify(toErrorPayload(error), null, 2) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(toErrorPayload(error), null, 2) }], isError: true };
  }
}

server.tool(
  'bili_account',
  'B站 账号自检：当前登录的是谁、关注数/粉丝数、凭证路径、关注开关是否放行。只读。',
  {},
  async () =>
    run(async () => {
      const { client: api, cred } = client();
      const me = await api.me();
      return {
        ok: true,
        account: me,
        expectedUid: cred.dedeuserid || null,
        credentialPath: cfg.credentialPath,
        allowFollow: cfg.allowFollow,
      };
    })
);

server.tool(
  'bili_followings',
  '列「舜的大肥魚」在 B站 关注了谁（按关注时间倒序）。只读。',
  {
    page: z.number().int().min(1).max(1000).optional().describe('第几页，默认 1'),
    limit: z.number().int().min(1).max(50).optional().describe('每页多少条，默认 30'),
  },
  async ({ page, limit }) =>
    run(async () => {
      const { client: api } = client();
      const result = await api.followings({ page: page ?? 1, limit });
      return { ok: true, ...result, count: result.items.length };
    })
);

server.tool(
  'bili_mentions',
  '看 B站 消息中心：谁 @ 了「舜的大肥魚」（at）、谁回了她的评论（reply）、谁点了赞（like）。只读。',
  {
    kind: z.enum(['at', 'reply', 'like']).optional().describe('at=@我（默认）/ reply=回复我 / like=点赞我'),
    limit: z.number().int().min(1).max(100).optional().describe('最多几条，默认 30'),
  },
  async ({ kind, limit }) =>
    run(async () => {
      const { client: api } = client();
      const result = await api.mentions({ kind: kind ?? 'at', limit });
      return { ok: true, ...result, count: result.items.length };
    })
);

server.tool(
  'bili_follow',
  '关注或取关某个 B站 用户（对外动作）。默认被 bili.allowFollow 挡着；uid 在对方主页 URL 里（space.bilibili.com/<uid>）。',
  {
    uid: z.string().describe('对方的 B站 UID（纯数字）'),
    action: z.enum(['follow', 'unfollow']).optional().describe('follow=关注（默认）/ unfollow=取关'),
  },
  async ({ uid, action }) =>
    run(async () => {
      const { client: api } = client();
      return api.follow({ uid, action: action ?? 'follow' });
    })
);

await server.connect(new StdioServerTransport());
