# 2026-11-13 lane 全面体检：她为什么「忽然不理人」

## 现象

- 有时发了消息她完全不回，过很久才回一条；日志里是 `Discord lane 回覆失敗（這則保留，下一輪重試）：等待回合逾時`。
- `state/bridge.log` 里 `连接 DSH 事件流…` 357 次、`DSH 事件流已结束（本次收到 0 帧）` 354 次。

## 根因（按严重程度）

1. **事件流断了不重连（P0）**
   `src/discord-lane.js` 的 `start()` 里只有 `consumeEvents().catch(...)`，跑一次就结束。DSH 把 mux 流关掉之后，`turn/start`、`assistant/message`、`turn/end` 再也收不到 → 每一轮 `runTurn` 都等满 `TURN_TIMEOUT_MS`，然后整条消息重试。表现就是「她不回，然后隔很久突然回一句」。
   修：新增 `connectEvents()`，无限重连 + 指数退避（2s→30s），断线时先把等待中的那轮 reject（保留水位，下轮重试），重连时重新 `ensureSession()`（会重新 follow）。

2. **自己的消息可能被当成他说的（P0）**
   `fetchNew()` 里有个 `const mine = new Set();`，然后 `if (m.authorId === mine)` —— 永远为 false，等于没过滤。之前只在 `tick()` 里靠 `state.botId` 挡一次，一旦第一次 `me()` 失败就会把 bot 自己的历史当成对方的新消息，让她「自己回自己」。
   修：删掉死代码，改成 `!state.botId || m.authorId !== state.botId`，并在 `fetchNew()` 里就过滤掉。

3. **消息排序精度（P1）**
   `sort((a, b) => Number(a.id) - Number(b.id))`：Discord snowflake 是 19 位，超出 `Number.MAX_SAFE_INTEGER`，同一毫秒内会排错。
   修：导出 `compareIds()`，用 `BigInt` 比较（解析失败退回字符串比较）。

4. **半截发送会重复（P1）**
   `send()` 分气泡、分段落发；第二段失败时整个 `send` 抛错 → `tick` 不推水位 → 下一轮把已经看到的前半段再发一次。
   修：`send()` 返回 `{ sent, failed }`，遇到 429/网络错误只记一条日志继续；`tick` 只要 `sent > 0` 就推进水位（记 `有 N 段沒送出去`），一条都没送出才算失败。

5. **长工具链被误判超时（P1）**
   看片/抽帧/下载字幕动辄几分钟，固定 180 秒超时会把正在干活的回合作废，然后重试——同一件事做两遍。
   修：`TURN_TIMEOUT_MS` 提到 240 秒，并且每收到一个属于这一轮的事件就 `waiting.touch()`（重新计时）。真正卡死还是会超时。

6. **QQ 关了但事件流还在空转（P2）**
   `pumpMux()` 是给 QQ 回覆用的，`snowluma.enabled=false` 之后它仍然每 30 秒重连一次、刷两条日志。
   修：`pumpMux()` 开头 `if (QQ_DISABLED) { log(...); return; }`。

7. **多图只送 4 张却没说明（P2）**
   修：超出 `MAX_IMAGE_COUNT` 时补一句 `[還有 N 張圖沒送進去]`。

## 顺手补的能力

- `replyPrompt()` 现在会带 `（你最近在忙：…）`（来自 `state/lane-loops.json` 的 `自己|`）——她会接着自己昨天在做的事说，而不是每次从零开始。
- 工作区规则补三条：想不起事就用 `xingxi_read` 查档案/日記；想长期记住某事用 `remember`；要查就真去查（`bili_search`/`bili_subtitle`/`video_storyboard`/`watch-words.mjs`/`web_search`），别凭印象编。

## 验证

- `scripts/test-discord-lane.mjs` 第 18 组（`compareIds`：19 位 id 排序、逆序、相等）。
- `scripts/test-discord-lane.mjs` 18 组、`test-lane-memory` 13 组、`test-audit` 149/149。
- 重启后日志应只有一条 `事件流…`；若 DSH 重启，会看到 `事件流中斷` → `事件流已重連`，而不是从此沉默。

## 遗留

- `pumpMux` 关掉之后，QQ 侧的 token 记账会停（QQ 本来就是关的，重启 QQ 时要一起恢复）。
- `send` 现在把「部分送达」当成功，极端情况下会少一段话——比重复整段好。
- 事件流重连没有上限，如果 DSH 一直拒绝（版本不兼容），日志会每 30 秒一条，需要看 `事件流中斷` 的具体错误。
