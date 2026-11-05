# B站 有人 @ 她，Discord 这边一直没动静

- 日期：2026-11-05
- 影响：`feat/discord-mcp` 分支（未发布）
- 涉及：`src/bili-core.js`、`src/bili-inbox.js`（新）、`src/discord-lane.js`、`src/bridge.js`

## 现象

主人在 Discord 私訊里跟 愛彌絲 聊天，说「小愛無法@我看東西」。
补充后确认：他要的「@」不只是 Discord 里的 @，还包括 **B站 上别人 @ 她**——那边有人找她，
她在 Discord 里照常聊天，完全不知道。

## 根因

1. `bili_mentions` 是**问一句才看一次**的工具：她不会在聊天中途自己想起来去翻，
   所以「有人 @ 她」这件事永远不会主动出现在对话里。
2. `normalizeMention` 把 `title` 当成正文（`content.title ?? content.source_content`），
   而 B站 `/x/msgfeed/at` 的 `source_content` 才是对方真正说的话——于是即使她翻了，
   也只看得到「在哪条内容下」，看不到「说了什么」。

## 改法

- `src/bili-core.js`：`normalizeMention` 拆成 `title`（在哪条内容下）+ `text`（`source_content`，
  对方原话）+ `type`。
- `src/bili-inbox.js`（新）：
  - 每 10 分钟拉一次 `/x/msgfeed/at` 与 `/x/msgfeed/reply`（不看点赞）；
  - `state/bili-inbox.json` 记 `kind:id`，**同一条只提醒一次**（最多留 200 条）；
  - **首轮只记水位不提醒**，免得一启动就把历史全推一遍；
  - 有新条目就 `lane.nudge(文案)`，文案里带「谁 / 在哪 / 说了什么 / 链接」，
    并提醒她「要回就在评论区用 `bili_reply`，别把整条链接复述到 Discord」；
  - `lane.nudge` 没送出去就**不记水位**，下一轮再推（不吞消息）。
- `src/discord-lane.js`：新增 `nudge(promptText)`，与主动开口共用同一个 `working` 闸；
  她的回答照常 `send()` 回 Discord 私訊。
- `src/bridge.js`：lane 启动后顺带起 inbox；`bili.enabled=false` 或没有 lane 就不启动。

## 验证

```text
node scripts/test-bili-inbox.mjs     # 11 项：文案/首轮水位/去重/送不出去不吞/无 lane
node scripts/test-bili-safe.mjs      # 16 项
node scripts/test-discord-lane.mjs   # 7 组
node scripts/test-audit.mjs          # 147/147
```

真机（重启 bridge 后）：

```text
16:32:34 [bridge] Discord lane 啟動：user=704494548008697926 poll=60000ms idle=30min
16:32:34 [bridge] B站提醒：已啟動（每 10 分鐘看一次 @ / 回覆）
16:32:34 [bridge] B站提醒：首次記錄 2 條水位，不提醒
```

## 遗留

- 只覆盖 at / reply；私信、动态流没接（`bili_received_replies` 那套在 Python MCP 里，没桥过来）。
- 提醒文案里给的是 B站 页面链接，不是评论原文的完整上下文（楼中楼要看 `bili_reply` 那条路）。
- 没有「她自动去 B站 回」——要不要回、回什么，仍然由她自己判断。
