# Discord 私訊「DSH 有回、Discord 沒收到」

## 現象

- 用户原话：「我發現有時訊息會跳不出來」→「主要是魚的心情那邊綁定的工作區有時會沒有回應，但是 dsh 內卻有」。
- 具體表現：同一個 Discord 私訊會話裡，有些回覆看得到、有些完全沒送出；去 DSH 該工作區翻，發現模型**其實回過**，只是沒貼回 Discord。
- 影響面：只影響 Discord 私訊 lane 的投遞，不丟資料（回覆仍在 session 記錄裡），但使用者感受像「她有時不回我」。

## 環境

| 項 | 值 |
| --- | --- |
| 系統 / DSH 版本 | Windows 11 / DSH desktop（Web GUI 6823） |
| SurfCore 版本 | v0.8.8 + `feat/discord-mcp`（`01d030f`）+ 未提交的 DM lane |
| 安裝方式 | junction（`~/.dsh/plugins/surfcore` → 工作區） |
| 其它相關版本 | `@addozhang/dsh-discord@0.6.5`、`dsh-speak-up@0.3.0`、`dsh-feiyu-mood@0.9.0` |

## 根因

- 代碼位置：`src/discord-lane.js` 舊版 `consumeEvents()`（`waiting`/`collector` 那段）與 `runTurn()`；`tick()` 的水位推進。
- 問題鏈條：
  1. lane 只認「有沒有 `turn/start`」，不認「這一輪是誰發起的」；
  2. 同一個 session `session-9efa6575…` 被三方寫入：DM lane 輪詢、`@addozhang/dsh-discord` gateway 注入、`dsh-speak-up` 念頭注入（`source.kind="speak-up"`）；
  3. 只要 `waiting` 還在，任何來源的 `turn/start` 都會讓 collector 開始收——收的是別人那一輪；collector 一結束就 resolve，回覆被當成「lane 的答覆」或整輪被丟棄；
  4. 其餘輪次的回覆只留在 DSH，不會貼回 Discord。
- 真機證據（`session-9efa6575…` 與 `state/discord-lane.json` 的 history 對照，4 條只在 DSH 裡）：
  - `06:21:13 B站轉了一圈，撈到一條值得看的：BV1txxF61Eoh…`
  - `06:26:57 喂，在忙？剛才不是說要掃碼的嘛，人呢。` ← 由 `06:26:54` 的 speak-up 念頭開的回合
  - `06:29:08 哦，那斷就斷了唄，重開一下試試。我在這兒呢，跑不掉。`
  - `06:32:05 碼畫好了，Discord 我發不了圖——你直接開這個文件掃：…qrcode_login.png`
- 為什麼之前沒發現：lane 是自己新寫的模組，只在「單一寫入者」的假設下跑過；一裝上 speak-up / host adapter 就破功，而測試只涵蓋 REST 那半條。

## 完整邏輯（給用戶看的那一遍）

- **鏈路**：`bridge.js` 起 `createDiscordLane()` → 每 `pollMs` 拉 DM → `api.sessions.prompt(mode:'queue')` 進 DSH session → 事件流收 assistant 文本 → `send()` 貼回 DM。
- **機制**：DSH 的 session 是可被多個插件注入的共享資源；「哪一輪是誰發起的」只有比對 `user/message` 正文才知道。舊寫法把「最近一個 `turn/start`」當成自己的，屬於所有權錯配。
- **爆炸半徑**：1 個進程 × 1 個讀者（DM）＝影響單一會話；不碰密鑰、不花錢；只是靜默丟投遞。
- **取捨**：A 分家（改綁定）只止血；C 全交給 host adapter 會失去主動開口；**B 認輪**才是治本——把投遞綁到「發起者」，之後再裝幾個注入型插件都不影響。
- **生效與重啟**：lane 跑在 `bridge.js` 常駐進程（`state/discord-lane.lock`），改完要重啟 bridge 進程。

## 修法

- 新增純函式 `createTurnAttributor()` + `samePromptText()`（`src/discord-lane.js` 頂部）：
  - `turn/start` → `user/message`（一般順序）與 `user/message` → `turn/start`（queue 順序）都支援；
  - 只認「正文與送出的 prompt 完全相同」且「turn 開始時間晚於 prompt 送出時間」的那一輪；
  - 一則 `user/message` 只屬於最近那個 `turn/start`，取用即清，避免誤掛。
- `consumeEvents()` 改成只把認領到的 turn 的事件餵給 collector；其他回合一律忽略。
- `tick()`：水位改成「送出成功才推進」（模型/網路失敗下一輪重試，不再永久丟訊息）；首次啟動只把「啟動前的歷史」當水位。
- 真機 06:29 那條 `source.kind="user"`（host adapter 注入）不再被 lane 當自己的回覆。

## 驗證

- 自動化：`node scripts/test-discord-lane.mjs`（7 組斷言，覆蓋正序/queue/別人回合/真實 06:26–06:29 序列/reset）；`node scripts/test-audit.mjs` → **144/145**（餘 1 條為 `test-release-manifest.mjs`，因上一個批次漏更新 `release/install-manifest.json`，已在本批修復）。
- 手動：以假事件序列重放 06:26–06:29，lane 只認 turn 12；turn 13 被忽略。
- 沒驗證到的部分：尚未在真機 DM 上重跑一輪 live 對話（需重啟 bridge 進程，等使用者確認）。

## 遺留 / 後續

- `test-release-manifest.mjs` 需要每次改檔後 `node scripts/release-manifest.mjs` 重新生成並提交。
- 可考慮把 `dsh-speak-up` 的念頭注入挪出這個 session，避免念頭污染聊天上下文（本次未改）。
- 附件仍只讀元數據，不支援下載。
