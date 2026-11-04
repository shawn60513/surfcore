# 新增 Discord MCP：像 SnowLuma 连 QQ 一样，在一轮对话里读写 Discord

日期：2026-11-05

## 现象

- 用户原话（m00001）：「那你有辦法像snowluma連接到QQ一樣連結到discord嗎」
- 追问（m00049）：「我比較想要第二種」—— 不要「把 DSH 会话搬到 Discord」，要「我在会话里直接调 Discord 工具」。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows / DSH `0.2.1-rc.5`（desktop profile） |
| SurfCore 版本 | dev（基于 `0deb826` v0.8.8） |
| 安装方式 | git 工作区 `default-workspace\surfcore` |
| 其它相关版本 | node v26.13.0；`@addozhang/dsh-discord@0.6.5`（已装、未启用） |

## 根因

本机**已有**两种「连 Discord」的路线，但都不是用户要的：

1. `@addozhang/dsh-discord` 是 **host 适配器**：它把 DSH 会话搬到 Discord（@bot 开 thread、流式回答、
   审批变按钮）。方向是「Discord → DSH」。
2. SnowLuma 是 **MCP server**：会话内调 `qq_*` 工具，由桥接替我在 QQ 说话。方向是「DSH → QQ」。

缺的是第 2 种路线的 Discord 版：一个 `stdio` MCP server，工具名在会话里是 `mcp__discord__*`。

## 完整逻辑

- **链路**：DSH 主进程 → `@deepseek-ai/dsh-mcp-client`（读 profile 的 `cordis.patch.yml` 里
  `id: mcp-discord-safe`）→ `node src/mcp-discord-safe.js`（stdio）→ `src/discord-core.js`
  → `https://discord.com/api/v10`（REST，Bot token）。
  反方向只有一条：Discord 用户发消息 → （若要自动回）由 `dsh-discord` 适配器接管，本 MCP 不订阅事件。
- **机制**：MCP 工具在本会话里由 DSH spawn 成子进程；每次工具调用是一次 REST 往返。
  白名单在 `requireAllowedChannel()` 强制：先 `GET /channels/{id}` 拿 `guild_id`，再比对
  `discord.guildIds` / `discord.channelIds`；两个名单都为空 → `discord.no-whitelist` 拒绝，fail-closed。
- **爆炸半径**：进程 1（MCP 子进程）× 读者 1（本会话模型）× 报错=1 → 3 分。碰密钥（token 只在
  `resolveDiscordToken` 出现，不进日志/错误文案/返回值）与对外发送（`discord.send_message`），但不花钱
  （Discord API 免费）。
- **取舍**：
  - A. 启用 `dsh-discord` 适配器 —— 被用户否掉（方向不对），且会把会话搬走。
  - B. 写 MCP server，只走 REST、不建 gateway —— 选这条：与已装的适配器共享同一 bot token 也不抢事件流；
    代价是没有「实时收到 Discord 消息」的推送，只能主动读。
  - 为什么不复用适配器内部代码：那是宿主插件，生命周期和 DSH 进程绑定，拿不到 stdio 入口。
- **生效与重启**：`cordis.patch.yml` 由 DSH 读取；本次写入后 DSH **热加载**了新 MCP
  （工具表里直接出现 `mcp__discord__*`），无需重启。若宿主没热加载，重启 DSH 即可。

## 修法

- 新增 `src/discord-core.js`（339 行，纯引擎，可离线测）：`discordRequest()` 统一超时/401/403/404/429
  （429 只重试一次，`retry_after ≤ 5s`）、`normalizeMessage()` 把原始 JSON 压成
  `{id,author,timestamp,content,...}`、`sanitizeMessageContent()` 空/超长直接报错（不静默截断）。
- 新增 `src/mcp-discord-safe.js`（171 行）：6 个工具 —— `discord_status`、`discord_list_channels`、
  `discord_read_messages`、`discord_send_message`、`discord_edit_message`、`discord_add_reaction`；
  失败统一 `{ok:false,code,error,hint}`。
- 发送一律带 `allowed_mentions: {parse: [], replied_user: false}`，文本里的 `@everyone` 不会真的 ping。
- `config.json` 加 `discord` 段（`enabled:true`、`guildIds:["1209805483066789908"]`、`channelIds:[]`、
  `allowSend:true`）；`config.example.json` 同步一份 `enabled:false` + 空白名单的样例。
- `scripts/setup-dsh.mjs`：`MANAGED_MCP_IDS` 加 `mcp-discord-safe`，`servers` 加
  `'mcp-discord-safe': { serverName: 'discord', script: src/mcp-discord-safe.js }`（否则下次 setup 会把它抹掉）。
- `scripts/test-mcp-servers-stdio.mjs` 加 discord；`scripts/test-audit.mjs` 列表加 `test-mcp-discord.mjs`。
- 回滚：删掉 profile `cordis.patch.yml` 里 `id: mcp-discord-safe` 那一段（备份在工作区 `_backups\`），
  或把 `config.json` 的 `discord.enabled` 改 false（工具还在，但一律回 `discord.disabled`）。

## 验证

- 自动化：`node scripts/test-mcp-discord.mjs` → 16/16（白名单 fail-closed、无 token、白名单外频道、
  `allowSend=false`、空/超长正文、429 重试、正序、`@everyone` 压制、replyTo → `message_reference`、
  token 不进返回值、stdio 六工具）。
- `node scripts/test-audit.mjs` → **144/144**，退出码 0。
- 真机（本会话内，只读）：
  ```text
  discord_status → ok, bot 大肥魚 (1567605287047659521), tokenSource=dsh-credentials,
                   whitelistedGuilds=[1209805483066789908]
  discord_list_channels → 一般 / 123 / default-workspace / general
  discord_read_messages(1567607735103656018) → ok, count=0
  ```
- **没验证到的**：真机「发一条消息」（`discord_send_message` 的线上路径）。发送 body 由离线测试钉住，
  但按规矩对外发送要用户点头，所以留到用户第一次真正用它时验证。

## 遗留 / 后续

- 没有「Discord 新消息推送」：要的话得接 gateway，会和 `dsh-discord` 适配器抢同一 token 的事件流，
  需要先确认适配器是否启用。
- 附件只能看到元数据（文件名/大小/类型），不下载内容。
- 线程（thread）里的消息：`discord_read_messages` 传 thread id 也能读，但没有专门的 thread 工具。
