# Discord 私訊 lane

讓她在 Discord 上用私訊跟你一對一聊天，並且會主動開口——跟 QQ 那邊的體感一致，但**不共用記憶**。

## 它是什麼

`src/discord-lane.js`：一條獨立的迴圈，跑在 QQ 橋接同一個 24/7 進程裡（也可以單獨當 daemon 跑）。

- **讀**：每 `pollMs`（預設 60s）用 Discord REST 讀 DM 頻道的新訊息（沒有 gateway，所以是輪詢）；
- **想**：把新訊息丟進一個專屬的 DSH 會話，人設從 `characters/` 讀同一份 `persona.md`；
- **寫**：把回覆貼回 DM（超過 1900 字自動分段）；
- **主動**：閒置超過 `idleMinutes` 且不在安靜時段，就讓她自己決定要不要開口（不想說話時模型回「跳過」）。

記憶刻意獨立：歷史存在 `state/discord-lane.json`，session 也是另一個，不會污染 QQ 的記憶卡。

## 開啟方式

`config.json`：

```json
"discord": {
  "enabled": true,
  "guildIds": ["<伺服器 ID>"],
  "lane": {
    "enabled": true,
    "userId": "<你的 Discord 使用者 ID>",
    "pollMs": 60000,
    "idleMinutes": 120,
    "quietStart": 23,
    "quietEnd": 8,
    "proactive": true
  }
}
```

- `userId`：要跟誰私訊（bot 必須跟他在同一個伺服器，且對方允許伺服器成員私訊）。
  bot 會用 `POST /users/@me/channels` 開 DM，不需要事先有頻道。
- 想關掉主動開口：`"proactive": false`。

## 指令

```bash
node src/discord-lane.js                # 常駐
node src/discord-lane.js --once         # 只跑一輪（建立 DM 與會話）
node src/discord-lane.js --say "你好"    # 只發一條私訊，驗證 token / 權限
node src/discord-lane.js --turn "你好"   # 只跑一次模型回合，不發 Discord
```

## 已知邊界

- 只走 REST：訊息延遲上限≈`pollMs`，不是即時推送；要做即時得接 gateway（目前刻意不接，避免跟 `@addozhang/dsh-discord` 搶事件流）。
- 單實例鎖：`state/discord-lane.lock`。獨立 daemon 與 bridge 內啟動的 lane 不會同時回你兩次。
- 會話是普通 DSH 會話，所以她在那邊能看到工具（QQ 的 MCP 也在），但提示詞要求只輸出聊天內容。
