# 在 DSH 裡回話，Discord 看不到

- 日期：2026-11-06
- 影响版本：v0.9.0 之前（lane 上线后一直如此）
- 现象：用户说「在 DSH 內回話，Discord 那邊不會同步顯示」。她在 Discord 私訊那边正常，但用户偶尔直接在 DSH 的 GUI 里对着同一个 lane 会话说一句，她的回复只出现在 DSH 里，Discord 私讯没有任何消息。

## 根因

`src/discord-lane.js` 的 `consumeEvents()` 是「只认自己发起的回合」的写法：

```js
if (!waiting) continue;          // 没有 lane 在等，整条事件流直接丢掉
...
if (!waiting.turn || !collector) continue;
```

`waiting` 只在 lane 主动 `prompt()` 之后才存在，所以**从 GUI 开的那一轮（`turn/start`、`assistant/message`、`turn/end`）在第一步就被丢掉了**——模型明明回答了，只是没人把答案送去 Discord。

这是上一轮「lane 认轮」修复的副作用：为了避免「别的来源注入的回合被 lane 误认成自己那一轮」，把所有非自己发起的回合都排除了；但「排除误认」和「完全不管」是两件事。

## 修法

不动「认轮」（那是防止重复投递的关键），另开一条只读的**镜像通道**：

1. `turn/start` 时给每个回合建一个槽：`mirrorTurns.set(turn, { text: '', own: false })`（`mirrorTurns = new Map()`，超过 200 条淘汰最早的）。
2. lane 自己认领到某一回合时（`turn/start` 认领，或 `user/message` 兜底认领），把那个槽标 `own = true`——**自己那轮已经 `send()` 过了，镜像要跳过**。
3. `assistant/message` 累积 `blocksToText(...)` 到槽里。
4. `turn/end` 时若 `!own` 且文本非空 → `queueMirror(text)`：同一段文字 2 分钟内不重发；`pushHistory('bot', text)`（下一轮 prompt 的「最近的對話」里能看到）；`send(text)`；日志 `Discord lane：DSH 那邊的一輪已同步到 Discord`。

`queueMirror` 用一条串行 promise 链（`mirrorChain`），避免两轮同时结束时气泡交错。

## 验证

- `node --check src/discord-lane.js`；`node scripts/test-discord-lane.mjs` 11 组断言通过。
- 真机：重启 bridge（PID 37480）后，用 DSH API 对 lane 会话 `session-8d562f23-fb39-4d33-8cc7-11728e16265e` 发一条「測試：這句話是從 DSH 這邊發的，Discord 看得到嗎？」，`state/bridge.log` 出现 `18:19:22 Discord lane：DSH 那邊的一輪已同步到 Discord`，Discord 私訊 `1567777542910386347` 收到回复「看得到，就正常显示在聊天里。」「那我刚说的那两条视频，你也收到了？」（`1568208156922880053` / `1568208167907762229`）。
- 反向验证：lane 自己发的回合没有被重复推送（`own` 标记生效；同一时段日志里没有第二条「已同步」）。

## 遗留 / 边界

- 镜像的是**这一个 lane 会话**里所有非 lane 发起的回合。若以后有别的插件也往这个会话开轮次（例如 speak-up），那些回复同样会被镜像到 Discord——目前 speak-up 总开关已关、目标会话已清空，所以不会发生；将来若重开，需要决定「它的话该不该进 Discord」。
- 镜像失败只记日志、不重试（用户已在 DSH 里看到答案，重试可能造成 Discord 里出现两条一样的）。
- 没有为它写单元测试：镜像依赖真实事件流（`session/event` 的 mux），现有 `test-discord-lane.mjs` 是纯函数级断言。若要加，需要把 `consumeEvents` 的镜像记账抽成 `applyMirrorEvent(state, event)` 纯函数。

## 補記（23:05）：镜像把她抄回来的提示词发进了 Discord

- 现象：让测试在一轮里调工具时，Discord 私訊出现一条几乎就是完整 `replyPrompt` 的消息（「（Discord 私訊）直接給聊天內容…最近的對話：」）。
- 根因：镜像个槽把这一轮**所有** `assistant/message` 的文字用 `\n` 拼起来；模型在多步工具调用时会先复述一遍指令，那一段也被当成回答送出去。
- 修法：`slot.text = piece`（后写覆盖先写），只在 `turn/end` 发最后一个 assistant 段。
- 验证：同样的「看这支片」测试重跑，Discord 只剩两三条真正的回答。

## 補記（23:20）：她還是會把提示詞複述一遍

- 现象：截图里 DSH 会话的 assistant 气泡开头是「（Discord 私訊）直接給聊天內容…（你記得的事：…）最近的對話：」，也就是把喂进去的提示当成要接的话，整段复述了一遍；Discord 那边也会收到。
- 根因两层：① prompt 写成「指令 + 对方刚说：…」，模型在多步工具调用后容易把指令当上下文继续；② 发送前没有任何过滤。
- 修法：
  - `replyPrompt()` 改成**对话记录**写法：第一行只有一条括号元信息（`（私訊 · 時間 · 你記得：…）`）+ 语气卡，然后把历史逐行写成 `對方：…` / `你：…`，最后一行是他刚发的那句。模型顺着对话回，而不是顺着说明做。
  - 新增导出 `stripPromptEcho(text, promptText)`：把整段 prompt 出现的位置剪掉，并按前缀（`（私訊`、`（你自己的語氣`、`（你記得的事`、`最近的對話：`、`對方剛說：`…）删掉提示行；`send()` 与 `queueMirror()` 都先过这一层。
  - 兜底：如果剪完只剩空字串，就保留原文（宁可发出去，也不要凭空吞掉一句回答）。
- 验证：`scripts/test-discord-lane.mjs` 第 12 组（整段照抄要剪干净、没传 prompt 时靠前缀也认得出、正常回答不能被动到、只剪提示那行）；真机看下一则 Discord 消息。
