import { createDiscordClient, loadDiscordConfig, resolveDiscordToken } from '../src/discord-core.js';
const cfg = loadDiscordConfig(process.cwd());
const { token, source } = resolveDiscordToken(cfg);
console.log('tokenSource', source, 'enabled', cfg.enabled, 'guildIds', cfg.guildIds, 'allowSend', cfg.allowSend);
const c = createDiscordClient({ token, cfg });
const me = await c.me();
console.log('bot', me.id, me.username);
for (const gid of cfg.guildIds) {
  const r = await c.request ? null : null;
  void r;
}
