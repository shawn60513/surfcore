# Discord lane 人設改成工作區指示（不再每輪重發）

- 日期：2026-11-06
- 影響面：`src/discord-lane.js` 的 prompt 組裝、lane 工作區 `state/discord-lane-workspace/AGENTS.md`
- 相關：`docs/DISCORD-DM-LANE.md`、`docs/cases/2026-11-05-discord-lane-turn-ownership.md`

## 现象

愛彌絲在 Discord 私訊裡每一輪的 prompt 都整段帶著人設：

```
你的人設：
人格设定
你不是AI、不是模型…（共 3604 字）
```

实测（`session-9efa6575…`，120 轮）：人設文本合计 **527,000 字**，而真人对话只有约 **1.9 万字**。
每轮 prompt 平均 3,665 字，人设占绝大部分。

两个问题：

1. **钱**：人設放在每轮新消息的最前面，不在缓存前缀里，每轮按原价重算（120 轮 ≈ 27 万 token）。
2. **上下文**：同一段文本在历史里反复出现，压缩器要反复搬运、反复摘要，摘要质量被稀释。

## 根因

`src/discord-lane.js` 的 `personaBlock()` 每轮读 `persona.md` 再拼进 prompt：

```js
function personaBlock() {
  const core = String(readPersonaLayerText?.('core') ?? '').trim();
  ...
  return { name, text: [core, daily].filter(Boolean).join('\n\n') };
}
```

调用点在 `replyPrompt()` / `proactivePrompt()` 的第一行，所以每轮都重发。
DSH 的 prompt cache 只缓存**请求前缀**（系统 + 历史消息），新消息里的这段永远是新 token。

## 修法（人設搬到工作區指示层）

DSH 会把**工作區根目录的 `AGENTS.md`** 作为「工作區指示」在会话开始注入一次——
这正是「一次性、跟着工作区走、吃缓存前缀」的位置。

1. 新增 `syncWorkspaceInstructions(root)`：把 `LANE_WORKSPACE_RULES`（Discord 私訊的说话方式）
   + `readPersonaLayerText('core')` + `daily` 写进
   `state/discord-lane-workspace/AGENTS.md`；内容没变不重写（避免每次启动都改文件）。
2. `ensureSession()` 开头先同步 AGENTS.md，再开新会话——DSH 开会话时注入。
3. `replyPrompt()` / `proactivePrompt()` 删掉人設段，只留：
   - `（Discord 私訊）直接給聊天內容…`
   - `最近的對話：…`（`HISTORY_LIMIT = 24` 条，来自 `state/discord-lane.json`）
   - `對方剛說：…`
4. 换会话才能让新 AGENTS.md 生效：备份 `state/discord-lane.json` 后把 `sessionId` 清空，
   保留 `workspaceId`（`ensureSession` 现在只在 `workspaceId` 为空时才创建 workspace）。

## 验证

- `node scripts/test-discord-lane.mjs` → 8 组断言通过
- `node scripts/test-audit.mjs` → **147/147**
- 新会话 `session-ef58a582-4e3f-4d98-9efd-6a087a4f28c4` 建在同一個 workspace；
  probe 会话（`session-91c7604e…`，同一 workspace、乾淨環境）的事件流里
  `user/message` 命中 `Discord 私訊工作區` → **工作區指示确实被注入**（probe 用完已 archive）。
- AGENTS.md 落盘 10,689 字节（人設 3,604 字 + 4 条规则）。

## 遗留

- AGENTS.md 只在**新会话**注入；若 DSH 在压缩后不重新注入工作区指示，长会话里人設会逐渐“淡化”。
  真机观察几轮后如果语气漂，就在 `tick()` 里加一道兜底：人設不在当前上下文时补一句 120 字语气卡。
- `persona.md` 改了之后，要重开 lane 会话才生效（`syncWorkspaceInstructions` 会重写 AGENTS.md，但已在跑的会话不受影响）。
- 旧会话 `session-9efa6575…` 里的历史（含 120 轮人設注入）还在，归档与否等观察后再定。
