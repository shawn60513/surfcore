// 長訊息自動拆條：Discord 單條上限 2000，超過就分段送，不能整段丟掉。
import assert from 'node:assert/strict';
import { createDiscordClient, splitMessage } from '../src/discord-core.js';

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

ok('短訊息不拆', () => {
  assert.deepEqual(splitMessage('晚安～', 2000), ['晚安～']);
  assert.deepEqual(splitMessage('', 2000), []);
});

ok('有句號時斷在句號附近，且每段都在上限內', () => {
  const text = '第一段話。'.repeat(700); // 3500 字
  const parts = splitMessage(text, 2000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 2000));
  assert.equal(parts.join(''), text, '拆完拼回去要跟原文一樣');
  assert.ok(parts[0].endsWith('。'), '優先斷在句號，不要硬切');
});

ok('沒有任何標點時硬切，也不超過上限', () => {
  const parts = splitMessage('字'.repeat(4500), 2000);
  assert.deepEqual(parts.map((p) => p.length), [2000, 2000, 500]);
});

ok('硬切不會把 emoji 拆成兩半', () => {
  const emoji = '🐟';
  const text = `${'字'.repeat(1999)}${emoji}${'字'.repeat(3000)}`;
  const parts = splitMessage(text, 2000);
  for (const part of parts) {
    const head = part.charCodeAt(part.length - 1);
    const tail = part.charCodeAt(0);
    assert.ok(!(head >= 0xd800 && head <= 0xdbff), '段尾不能是半個代理對');
    assert.ok(!(tail >= 0xdc00 && tail <= 0xdfff), '段首不能是半個代理對');
  }
});

ok('sendMessage 自動拆成多條送出，引用只掛第一條', async () => {
  const posts = [];
  let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return new Response(JSON.stringify({ id: '1567608054743310428', type: 0, guild_id: '1209805483066789908' }), { status: 200 });
    }
    posts.push(JSON.parse(init.body));
    counter += 1;
    return new Response(JSON.stringify({ id: `msg-${counter}`, content: posts.at(-1).content }), { status: 200 });
  };
  const client = createDiscordClient({
    token: 't',
    cfg: { allowSend: true, guildIds: ['1209805483066789908'], channelIds: [], maxContentLength: 2000, requestTimeoutMs: 15000 },
    fetchImpl,
  });
  const long = '这是很长的一段话。'.repeat(300); // 2700 字
  const res = await client.sendMessage('1567608054743310428', { content: long, replyTo: '123456789012345678' });
  assert.equal(res.ok, true);
  assert.equal(res.parts, posts.length);
  assert.ok(posts.length >= 2, '超过 2000 字要拆成两条以上');
  assert.ok(posts.every((p) => p.content.length <= 2000));
  assert.ok(posts[0].message_reference, '第一条要带引用');
  assert.ok(!posts[1].message_reference, '后面的段不该重复引用');
  assert.equal(res.id, `msg-${posts.length}`);
  assert.deepEqual(res.ids.length, posts.length);
});

ok('空內容仍然報錯，不會靜默送空訊息', async () => {
  const client = createDiscordClient({
    token: 't',
    cfg: { allowSend: true, guildIds: ['1'], channelIds: [], maxContentLength: 2000 },
    fetchImpl: async () => new Response(JSON.stringify({ id: '1', type: 0, guild_id: '1' }), { status: 200 }),
  });
  await assert.rejects(() => client.sendMessage('123456789012345678', { content: '   ' }), /discord\.empty-content|消息内容为空/);
});

console.log(`test-discord-split：${passed} 組通過`);
