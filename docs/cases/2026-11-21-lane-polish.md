# 語氣重修：把「魚八股」再磨一道

- **日期**：2026-11-21
- **版本**：0.9.1
- **來源**：B站 [BV1yYsU63Ejh](https://www.bilibili.com/video/BV1yYsU63Ejh/)「鱼八股？没人味？终于可以改善大肥鱼的人机腔了！！！」——他讲四招：换最终模型、推理填充、推理注入、大力出奇迹（每句重来或事后修）。

## 為什麼選「事後修」這條

- 換模型：要動 lane 會話的模型，牽涉整個 profile，先不動。
- 推理填充：影片作者自己說廢了（相容性差、推理動不動壞掉）。
- 推理注入：得拿模型自己的思考結構寫範例，成本高、效果不確定。
- 大力出奇蹟：**語氣參考給足時，模型第一句的合格率最高、越往後越散**。所以把已經生成的那句丟回一個「乾淨請求」（只帶腔調參考、不帶整段上下文）重寫，最容易把生硬磨掉，又不用把上下文再洗一遍。

## 實作

`src/discord-lane.js`：

- 模組層導出兩個純函式（可測）：
  - `buildPolishPrompt(text)`：一段「這不是聊天，是校稿」的請求，列出規則（1–3 句、不要句號、不要前言解釋）、她的腔調、三組味道參考，最後貼上原文。**刻意不帶 history**。
  - `acceptPolished(original, polished)`：三道保守檢查——空的不收、跟原文一樣的不收、長度超過 `max(60, 原文×2)` 的不收（多半是加了廢話），開頭是「改寫／以下是」這種前言的也不收。
- 工廠內 `polishReply(text)`：
  - 讀 `discord.lane.polish`（`enabled` / `minChars` 預設 6 / `maxChars` 預設 600），太短、太長、或是「跳過」都不修。
  - 用 `runTurn(buildPolishPrompt(raw))` 走同一條會話（不開新會話、不上工具），回來先過 `stripPromptEcho`，再過 `acceptPolished`。
  - 任何一步失敗只記 `語氣重修沒過（…），這句照原樣發`，不影響發送。
- 接在 `tick()` 的 `runTurn` 之後、`pushHistory` 之前：`reply = await polishReply(reply);`——上下文裡存的是修過的句子，下一輪看到的就是最終版本。

## 設定

```json
"discord": {
  "lane": {
    "polish": { "enabled": true, "minChars": 6, "maxChars": 600 }
  }
}
```

`config.example.json` 留同結構但 `enabled: false`。

## 驗證

- `scripts/test-discord-lane.mjs` 第 23 組：提示詞含「只回改寫後的句子」「不要解釋」、帶原文、**不含「最近的對話」**；驗收的六種情況（空、相同、超長、帶前言、正常替換、原文為空）。
- 23 組全過。
- 真機：每次重修成功會在 `state/bridge.log` 記一行 `Discord lane：語氣重修了一道`；想知道有沒有生效，跟它聊兩句再搜這行。

## 補記（06:05）：鏡像那條路也要修

原本只有「她回 Discord 訊息」會走 `polishReply()`；如果用户直接在 DSH 這邊跟同一個 lane 會話聊，那句是靠 `queueMirror()` 同步到 Discord 的，走的是另一條路，語氣就沒修過——等於同一个人两个样。

修法：`queueMirror()` 進 `mirrorChain` 之後、`pushHistory`/`send` 之前也過一次 `polishReply()`，失敗就用原文。因為 `polishReply()` 內部是 `runTurn()`，那一輪會被「認輪」標成自己開的（`slot.own = true`），所以重修出來的句子不會再被鏡像一次，不會遞迴。

## 代價 / 遺留

- 每輪多一次短請求，約多 3–6 秒、多幾百 token（用户已明說不必為 token 妥協）。
- 重修只處理「一句話的腔調」，不處理內容錯誤；如果模型答錯事實，這道不會救。
- 若之後發現重修讓回覆變短、資訊掉了，把 `maxChars` 調小或直接 `enabled: false` 回滾。
