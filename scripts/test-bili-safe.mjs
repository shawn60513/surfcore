// 测试 B站 MCP server（src/mcp-bili-safe.js + src/bili-core.js）。
//
// 离线：假 fetch + 临时凭证文件，不联网、不真关注任何人。
// 另有一条 stdio 接入测试：像 DSH 的 dsh-mcp-client 一样拉起 server 握手 + listTools。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createBiliClient,
  loadBiliConfig,
  readCredential,
  toErrorPayload,
} from '../src/bili-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, headers: init.headers });
    const result = handler({ url: String(url), method: init.method ?? 'GET', body: init.body }) ?? {};
    const { status = 200, json = {} } = result;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  impl.calls = calls;
  return impl;
}

const cred = { sessdata: 'SESS', bili_jct: 'JCT', buvid3: 'BUV', dedeuserid: '42' };
const baseCfg = { enabled: true, allowFollow: false, requestTimeoutMs: 5000, maxItems: 30 };

// ── 1. 配置默认值 ───────────────────────────────────────────────
{
  const cfg = loadBiliConfig(path.join(ROOT, '__no_such_dir__'));
  check('缺 config：默认启用、关注关着、凭证走默认路径',
    cfg.enabled === true && cfg.allowFollow === false && cfg.credentialPath.endsWith('bili_credential.json'));
}

// ── 2. 凭证缺失 / 不完整 ────────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-cred-'));
  let missing = '';
  try { readCredential(path.join(tmp, 'nope.json')); } catch (e) { missing = toErrorPayload(e).code; }
  check('凭证文件不存在 → bili.no-credential', missing === 'bili.no-credential', missing);

  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ sessdata: 'x' }));
  let partial = '';
  try { readCredential(bad); } catch (e) { partial = toErrorPayload(e).code; }
  check('只缺 bili_jct → 也当没登录', partial === 'bili.no-credential', partial);

  const ok = path.join(tmp, 'ok.json');
  fs.writeFileSync(ok, JSON.stringify({ sessdata: 'a', bili_jct: 'b', buvid3: 'c', dedeuserid: 7 }));
  check('完整凭证可读', readCredential(ok).dedeuserid === '7');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 3. me() 解析 ────────────────────────────────────────────────
{
  const fetchImpl = fakeFetch(() => ({ json: { code: 0, data: { mid: 42, uname: '舜的大肥魚', isLogin: true, following: 0, follower: 3 } } }));
  const api = createBiliClient({ cred, cfg: baseCfg, fetchImpl });
  const me = await api.me();
  check('me 解析昵称/uid/关注数', me.name === '舜的大肥魚' && me.uid === '42' && me.following === 0, JSON.stringify(me));
  check('me 请求走 /x/web-interface/nav', fetchImpl.calls[0].url.includes('/x/web-interface/nav'));
}

// ── 4. 关注列表：查询串 + 解析 ──────────────────────────────────
{
  const fetchImpl = fakeFetch(({ url }) => {
    if (url.includes('/x/web-interface/nav')) return { json: { code: 0, data: { mid: 42, uname: 'me', isLogin: true } } };
    return {
      json: {
        code: 0,
        data: {
          total: 2,
          page: 1,
          list: [
            { mid: 111, uname: '甲', sign: '签名甲', official_verify: { title: '个人认证' } },
            { mid: 222, uname: '乙', sign: '', official_verify: {} },
          ],
        },
      },
    };
  });
  const api = createBiliClient({ cred, cfg: baseCfg, fetchImpl });
  const res = await api.followings({ page: 1, limit: 5 });
  const q = fetchImpl.calls.find((c) => c.url.includes('/x/relation/followings')).url;
  check('followings 带 vmid/pn/ps', q.includes('vmid=42') && q.includes('pn=1') && q.includes('ps=5'), q);
  check('followings 解析条数与字段', res.total === 2 && res.items.length === 2 && res.items[0].name === '甲' && res.items[0].official === '个人认证');
}

// ── 5. @ 我 ─────────────────────────────────────────────────────
{
  const fetchImpl = fakeFetch(() => ({
    json: {
      code: 0,
      data: {
        total: 1,
        items: [
          { at_time: 1793000000, user: { mid: 9, uname: '某甲' }, item: { id: 7, title: '标题', uri: 'bilibili://video/1', source_content: '说了一句' } },
        ],
      },
    },
  }));
  const api = createBiliClient({ cred, cfg: baseCfg, fetchImpl });
  const res = await api.mentions({ kind: 'at', limit: 10 });
  check('mentions 走 /x/msgfeed/at', fetchImpl.calls[0].url.includes('/x/msgfeed/at'));
  check('mentions 解析出人/标题/链接', res.items[0].user === '某甲' && res.items[0].title === '标题' && res.items[0].url.startsWith('bilibili://'));
}

// ── 5b. @ 我的 user 字段只有 nickname（真实响应就是这样） ────────
{
  const fetchImpl = fakeFetch(() => ({
    json: {
      code: 0,
      data: {
        total: 1,
        items: [
          { at_time: 1793000001, user: { mid: 23388718, nickname: '小愛' }, item: { id: 8, title: '设定图', uri: 'https://t.bilibili.com/1' } },
        ],
      },
    },
  }));
  const api = createBiliClient({ cred, cfg: baseCfg, fetchImpl });
  const res = await api.mentions({ kind: 'at', limit: 5 });
  check('mentions 认得仅带 nickname 的用户', res.items[0].user === '小愛' && res.items[0].uid === '23388718', JSON.stringify(res.items[0]));
}

// ── 6. 关注默认被挡 ────────────────────────────────────────────
{
  const api = createBiliClient({ cred, cfg: baseCfg, fetchImpl: fakeFetch(() => ({})) });
  let code = '';
  try { await api.follow({ uid: '111' }); } catch (e) { code = toErrorPayload(e).code; }
  check('allowFollow=false 拒绝关注', code === 'bili.follow-disabled', code);
}

// ── 7. 关注 / 取关的请求体 ──────────────────────────────────────
{
  const fetchImpl = fakeFetch(() => ({ json: { code: 0, data: {} } }));
  const api = createBiliClient({ cred, cfg: { ...baseCfg, allowFollow: true }, fetchImpl });
  await api.follow({ uid: '111', action: 'follow' });
  const post = fetchImpl.calls[0];
  const body = new URLSearchParams(post.body);
  check('关注：POST + fid/act=1/csrf',
    post.method === 'POST' && post.url.includes('/x/relation/modify') && body.get('fid') === '111' && body.get('act') === '1' && body.get('csrf') === 'JCT');
  await api.follow({ uid: '111', action: 'unfollow' });
  check('取关：act=2', new URLSearchParams(fetchImpl.calls[1].body).get('act') === '2');
}

// ── 8. 业务错误映射 ────────────────────────────────────────────
{
  const api = createBiliClient({ cred, cfg: baseCfg, fetchImpl: fakeFetch(() => ({ json: { code: -101, message: '账号未登录' } })) });
  let payload = {};
  try { await api.me(); } catch (e) { payload = toErrorPayload(e); }
  check('code=-101 映射成 bili.api--101 且带 hint', payload.code === 'bili.api--101' && Boolean(payload.hint), JSON.stringify(payload));
}

// ── 9. 评论 / @ ────────────────────────────────────────────────
{
  const api = createBiliClient({ cred, cfg: baseCfg, fetchImpl: fakeFetch(() => ({ json: { code: 0 } })) });
  let payload = {};
  try { await api.comment({ bvid: 'BV1xx411c7mD', message: '你好' }); } catch (e) { payload = toErrorPayload(e); }
  check('allowComment 未开时拒绝发评论', payload.code === 'bili.comment-disabled', JSON.stringify(payload));

  const fetchImpl = fakeFetch(({ url }) => {
    if (url.includes('/x/web-interface/view')) return { json: { code: 0, data: { aid: 123456 } } };
    if (url.includes('/x/web-interface/card')) return { json: { code: 0, data: { card: { name: '琥珀之梟' } } } };
    if (url.includes('/x/v2/reply/add')) return { json: { code: 0, data: { rpid_str: '999', rpid: 999 } } };
    return { json: { code: 0 } };
  });
  const api2 = createBiliClient({ cred, cfg: { ...baseCfg, allowComment: true }, fetchImpl });
  const out = await api2.comment({ bvid: 'BV1xx411c7mD', message: '來看這個', mentionUid: '23388718' });
  const post = fetchImpl.calls.find((c) => c.url.includes('/x/v2/reply/add'));
  const body = new URLSearchParams(post.body);
  check('评论：bvid→aid、自动 @ 昵称、POST 带 oid/type/csrf',
    out.ok && out.aid === '123456' && out.text === '@琥珀之梟 來看這個' && body.get('oid') === '123456'
      && body.get('type') === '1' && body.get('csrf') === 'JCT',
    JSON.stringify({ aid: out.aid, text: out.text }));

  const again = await api2.comment({ aid: '123456', message: '@琥珀之梟 早就 @ 了', mentionUid: '23388718' });
  check('评论：正文已经 @ 过就不重复加', again.text === '@琥珀之梟 早就 @ 了', again.text);

  let long = {};
  try { await api2.comment({ aid: '123456', message: 'x'.repeat(1001) }); } catch (e) { long = toErrorPayload(e); }
  check('评论：超过 1000 字拒绝', long.code === 'bili.comment-too-long');

  let noUid = {};
  try { await api2.comment({ aid: '123456', message: '   ' }); } catch (e) { noUid = toErrorPayload(e); }
  check('评论：空白正文拒绝', noUid.code === 'bili.empty-comment');
}

// ── 9b. stdio 接入 ─────────────────────────────────────────────
{
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp-bili-safe.js')],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bili-mcp-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ['bili_account', 'bili_follow', 'bili_followings', 'bili_mentions', 'bili_reply'];
    check('stdio 握手 + 五个工具齐全', JSON.stringify(names) === JSON.stringify(expected), names.join(','));
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/EPERM/.test(message)) {
      console.log('⚠️ 跳过 stdio 子进程测试：当前沙箱禁止 pipe spawn（EPERM），在普通 shell 里重跑本脚本可验证');
    } else {
      check(`stdio 接入失败：${message}`, false);
    }
  } finally {
    try { await client.close(); } catch {}
  }
}

if (failures) {
  console.error(`\ntest-bili-safe: ${failures} 项失败`);
  process.exit(1);
}
console.log('\ntest-bili-safe: 全部通过');
