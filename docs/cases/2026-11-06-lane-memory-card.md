# Discord lane 每輪帶一小段「記憶卡」

- 日期：2026-11-06
- 影響面：`src/discord-lane.js`（prompt 組裝 + 啟動日誌）、`config.json` / `config.example.json` 的 `discord.lane.memoryCard`
- 相關：`docs/cases/2026-11-06-lane-persona-to-agents.md`、星汐插件 `dsh-xingxi`

## 现象

lane 会话（`session-9efa6575…` / 後來的 `session-ef58a582…`）**不读任何记忆**：

- prompt 只有 `（Discord 私訊）…` + 最近 24 条历史；
- 系统提示是通用 DSH 文案，没有 fish-memory 的块；
- surfcore 的 `memory-card.json`、fish-memory 的 `bili-whale-char-mw372r7g.json` 都不会被 lane 读到。

结果：她在 Discord 里问「我们之前聊过什么」只能靠 24 条上下文，超出就断片。

## 根因

三套记忆各活各的：

| 存储 | 谁写 | 谁读 |
|---|---|---|
| `~/.dsh/surfcore/characters/<id>/memory/memory-card.json` | QQ / B站 / 桌宠场景 | 那三个场景 |
| `~/.dsh/fish-memory/*.json` | 宿主 fish-memory 插件（自动抽取、会衰减） | 开了开关的会话（按系统提示注入） |
| `~/.dsh/xingxi/会话/<档案>/记忆卡.md` | 人 / 拾星整理 | 星汐（画星图）、`xingxi` 工具 |

lane 三条都不属于，所以一条都读不到。

## 修法

选「记忆卡」当**唯一长期真相**（可读、可改、可被星汐画出来），lane 每轮从里面取一小段：

1. `src/discord-lane.js` 新增导出 `readMemoryBrief(file, limit = 300)`：
   - 只取「三｜对方是谁」「五｜我们的约定」两章（这两章决定「怎么称呼、答应过什么」，比流水账有用）；
   - 每条去 `- ` 前缀，用 `；` 连成一行，超过 300 字截断加 `…`；
   - 文件不存在 / 读失败 / 全是空行 → 返回 `''`（当没有，不报错）。
2. `replyPrompt()` / `proactivePrompt()` 在有摘要时插一行 `（你記得的事：…）`；没有就整行不出现（不占 token）。
3. 配置：`config.json` 的 `discord.lane.memoryCard` 指到档案路径，`config.example.json` 留空串（默认不读）。
4. 启动时打一行 `Discord lane：記憶卡已載入（N 字）`，读不到就打 `記憶卡讀不到內容（路径）`——避免路径写错却静默失效。

配套（不在本仓代码里）：

- 档案：`~/.dsh/xingxi/会话/爱弥丝/记忆卡.md` + `日记/2026-11-04.md`、`日记/2026-11-05.md`，由旧角色 23 条记忆整理而成（`char-mw2brgz1` → `char-mw372r7g`，换角时没迁移）。
- `~/.dsh/xingxi/config.json` 的 `绑定` 把 lane 会话与主会话都指到该文件夹，`xingxi` 工具才读得到。
- `~/.dsh/fish-memory-config.json`：lane 会话设 `false`（避免两套记忆打架），主会话保持默认。

## 验证

- `node scripts/test-discord-lane.mjs`：第 9 组断言用临时 `记忆卡.md` 验证「只取三、五两章、其余不混入、文件不存在返回空串」全过。
- `node scripts/test-audit.mjs`：**147/147**。
- 真机（`state/bridge.log`）：`01:46:05 [bridge] Discord lane：記憶卡已載入（164 字）`。
- 真机 prompt：下一轮 `user/message` 的首行应出现 `（你記得的事：他叫「上午不順」…）`。

## 遗留

- 摘要固定取两章，不会随对话内容变化；如果以后要「按话题取相关章节」，得做关键词匹配（星汐的 `xingxi_read` 是现成的接口，但 lane 内没有工具调用，只能预取）。
- `memoryCard` 是绝对路径，换机器/换档案名要改配置；没有做「相对 workspace」的兜底。
- 拾星写档案时是「整章追加」，如果它把第三章写重了，摘要会变长——300 字上限会截断，但截断点未必好看。

## 追加：让她自己记（2026-11-06 02:00）

只读的记忆卡有个副作用：她说「记下了」只是嘴上说，档案没动。补一条写回路：

**日记自动写（不过模型）**
- `src/discord-lane.js` 在每次「送出成功」后调 `appendDiary(memory, { user: content, assistant: reply })`。
- 落盘 `日记/YYYY-MM-DD.md`，第一行 `【日期】`，之后每轮一行：`- **HH:mm** 他：… → 我：…`，两边各截 200 字。
- 写到失败也只吞异常，不影响回消息。

**每晚整理（过一轮模型，她自己挑）**
- `tick()` 末尾 `maybeConsolidate()`：当本地小时 ≥ `discord.lane.consolidateHour`（默认 23）且今天还没整理过。
- 读当天日记 → `buildConsolidatePrompt()` 让她输出「章号|内容」（最多 3 条，章号只能三/五/六）→ `parseConsolidate()` 解析 → `appendCardEntries()` 写回记忆卡。
- 为什么不让模型直接改文件：章标题、缩进、插错章这些它经常写坏，写坏了整章摘要都读不到。这里**只让模型选内容**，写档由代码做，而且写前落 `記憶卡.md.bak-<日期-时间>` 备份。
- 今天没有新东西 → 她回「沒有」，不写档；整理失败 → `lastConsolidated` 清空，下一轮重试。

**验证**
- 新增 `scripts/test-lane-memory.mjs`（7 组：日期格式、日记追加、提示词、解析过滤、插对章 + 有备份、空/未知章不写、每天只整理一次），已登记进 `test-audit` → **148/148**。
- 真机 `01:58:52 Discord lane：記憶卡已載入（164 字）`。

**边界**
- 日记是纯追加，不轮转；一天聊很多行也没关系（几百 KB 以内），但一个月后建议加按天分文件（本来就是按天的）。
- 整理那一轮会占用 lane 的 `working` 闸，最多几十秒；期间来的私信会等到下一轮（下一分钟）才回。
- 「章号|内容」靠模型自觉，写歪的行会被丢掉，不会污染档案。
