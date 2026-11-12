# 長訊息送不出去 & 主動開口老講同一句

**日期**：2026-11-13

## 一、超過 2000 字的回覆整段丟掉

**現象**：她偶爾回一大段（講片子的時候），那一段完全沒出現在 Discord；日誌只留「有一段沒送出去」。

**根因**：`src/discord-core.js` 的 `sanitizeMessageContent()` 對超過 `maxContentLength`（2000）直接拋
`discord.too-long`，而 `sendMessage()` 只發一條 → 整段失敗。lane 的 `splitBubbles()` 只限制**條數**
（最多 3 條），不限制每條長度，所以超長的一段必然失敗。

**修法**：

- 新增 `splitMessage(text, maxLength)`：優先斷在空行、換行、句號/問號/驚嘆號/逗號；真的沒有標點才硬切，
  硬切時避開代理對（emoji 不會被切成半個）。
- `sendMessage()` 改成逐段送出，回傳 `{ id, ids, parts }`；**引用只掛第一條**，`@everyone` 壓制照舊逐條套用。
- 空內容仍然拋錯（不會靜默送空訊息）。

**驗證**：新 `scripts/test-discord-split.mjs` **6 組**（短訊息不拆、斷在句號、硬切、emoji 邊界、
一次送多條且引用只掛第一條、空內容報錯）。

## 二、主動開口兩天講同一句

**現象**：主動私訊的開場常常是同一句（「在嗎」「醒了沒」），看起來像罐頭。

**根因**：`proactivePrompt()` 雖然帶了最近 6 條對話，但沒有「跟自己最近講過的話比對」這一步；
模型很容易回到最順手的那句。

**修法**：新增 `looksRepeated(text, recent, threshold = 0.7)`（字元二元組重疊度），`tick()` 在主動開口前
跟**自己最近 5 條**比；太像就記「主動開口又講同一句，這次算了」，不發、也不推 `lastBotAt`。

**驗證**：`scripts/test-discord-lane.mjs` 第 20 組（一樣的算重複、換虛詞也算、不同句子照發、太短不判斷、
沒歷史不擋）。

**測試總計**：`test-discord-split` 6 組、`test-discord-lane` 20 組、`test-lane-memory` 14 組，
`test-audit` **152/152**。

**影響面**：

- 長回覆會變成連續幾條訊息（每條最多 2000 字）；MCP 的 `discord_send_message` 也受益。
- 主動開口偶爾會「這次不講」——那是刻意的，避免罐頭感。
**影響面**：
**遺留**：拆條沒有做「合併相鄰短段」的最佳化；極端情況（連續 5000 字無標點）會切成三條硬邊。
