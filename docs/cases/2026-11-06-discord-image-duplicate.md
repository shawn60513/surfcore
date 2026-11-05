# Discord 私訊：傳一張圖，她反覆回同一張

- 日期：2026-11-06
- 分支：`feat/discord-mcp`
- 相关：`2026-11-05-discord-lane-turn-ownership.md`（同一套回合归属逻辑）、Discord 图片支持（同批）

## 现象

用户在 DM 里先发了一张图（`IMG_7767.jpg`），她正常回了一次；之后再发图/接着聊，她那边
「看都是重複的」——同一张 `IMG_7767.jpg` 被反复处理，隔几分钟回一次，聊到后面的内容就卡住了。

`state/bridge.log`：

```
01:01:06 [bridge] Discord lane 回覆失敗（這則保留，下一輪重試）：等待回合逾時
01:05:03 [bridge] Discord lane 回覆失敗（這則保留，下一輪重試）：等待回合逾時
01:09:03 [bridge] Discord lane 回覆失敗（這則保留，下一輪重試）：等待回合逾時
01:13:04 [bridge] Discord lane 回覆失敗（這則保留，下一輪重試）：等待回合逾時
```

会话里同一则消息出现了 4 次（16:58 / 17:02 / 17:06 / 17:10 UTC），
image part 的 `attachmentId` 全是 `sha256:0c7d1c8f…`，`name: IMG_7767.jpg`。

## 根因

两层，缺一不可：

1. **正文对不上。** Discord 图片支持把图片说明（`[圖片1：IMG_7767.jpg]`）当成**另一个 text block**
   塞进 prompt：`content = [{text: promptText}, {text: '[圖片1：…]'}, {image…}]`。
   DSH 原样保存这则 user/message，而 `consumeEvents()` 里判断「这轮是不是我发的」靠的是
   `blocksToText(...) === promptText`——多了一行说明就永远不相等，`waiting.turn` 一直是 null。
2. **超时后不推水位，于是同一则重发。** 那一轮其实 2 秒就跑完了（`assistant/message` → `step/end`
   → `turn/end` 都在），但 lane 认不到，白等 `TURN_TIMEOUT_MS = 180_000`；水位只在发送成功后推进
   （这是 11-05 修的），所以每 4 分钟（180s + 一次 poll）把同一张图再送一遍。
   模型每次都能答，但答完不进 Discord，用户看到的是「同一张图被反复回」。

## 修法

`src/discord-lane.js`：

- `fetchImageParts()` 改成返回 `{ parts, note }`：`parts` 只放 image part，说明文字（`[圖片N：…]`、
  `[圖片N 太大，沒送進去]`、`[圖片N 沒抓下來：…]`）收集成 `note`。
- 调用端把 `note` 拼进 **promptText 本身**：`basePrompt + '\n' + note`，再 `runTurn(promptText, parts)`。
  这样事件里的正文与 promptText 一致，归属判断恢复；退回纯文字重试时同一个 promptText 也仍成立。
- 新增导出 `isPromptMessage(text, promptText)`：完全相等，**或**以 prompt 开头（归一化空白后）就算同一则。
  只放宽「尾巴多出来」，不放宽到任意相似，避免 11-05 那种抓到别人回合的问题复发。
  `createTurnAttributor().onUserMessage()` 改用它。
- 超时错误带上 turn：`等待回合逾時（turn=12）` / `（turn=null）`，下次一眼能看出卡在「没认到回合」
  还是「回合没结束」。

## 验证

- `node scripts/test-discord-lane.mjs` → **8 组**；新增第 8 组直接复现事故：正文带
  `[圖片1：IMG_7767.jpg]` 时必须归到自己那一轮，换成完全不同的句子则不能认。
- `node scripts/test-mcp-discord.mjs` 全过；`node scripts/test-audit.mjs` **147/147**。
- 真机：重启 bridge（PID 31432）后 `01:14:25 Discord lane 啟動`，下一轮 poll `01:14:44 Discord lane：回了 上午不順 一句`，
  `state/discord-lane.json` 的 `lastMessageId` 推进到 `1567945879850328211`，不再重复同一张图。

## 遗留

- 只修了「归属认不到」这一条路；如果某轮真的卡在模型侧（turn 不结束），仍会等满 180 秒再重试。
- 图片上限仍是 4 张 / 8MB；超出会退成 `[圖片N 太大，沒送進去]` 文字说明（这一行现在也计入 promptText）。
