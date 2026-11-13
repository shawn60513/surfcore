# 她忽然不理人：積壓超過一頁，水位被自己的訊息堵死

- **日期**：2026-11-13
- **版本**：0.9.1
- **現象**：用户在 Discord 私訊發「小愛早安」「我要去上班囉」，**完全沒有回**。bridge 進程活著、127.0.0.1:3100 在聽、日誌沒有錯誤，只有一行「事件流被關閉，稍後重連（DSH 重啟）」。
- **環境**：DSH 07:52 重啟，GUI 端口由 12963 → 9888；`config.json` 的 `dsh.baseUrl` 還停在 `http://127.0.0.1:1507`。

## 根因（兩層）

1. **端口過期**：DSH 重啟後回環端口會換，`config.json` 的 `dsh.baseUrl` 是舊的。lane 的 `resolveBaseUrl()` 會探測並改寫，但若這一步沒走完（或寫回的仍是舊值），後續 prompt 全部打在空氣上。
2. **抓訊息只抓一頁、還先把 bot 自己的訊息濾掉**（真正的主因）：

```js
// 舊版 fetchNew()
const query = new URLSearchParams({ limit: '20' });
if (state.lastMessageId) query.set('after', state.lastMessageId);
...
.filter((m) => !state.botId || m.authorId !== state.botId)   // ← 這裡
```

- Discord 的 `after=` 是**由舊往新**回，一次最多 100 條。積壓超過一頁時，只抓第一頁＝永遠只看到最舊的那批。
- 抓完還把 bot 自己的訊息濾掉 → tick 拿不到「自己的訊息」這條路徑去推水位（tick 裡本來有 `state.lastMessageId = msg.id` 的分支）。
- 兩件事合起來：**水位卡在 20 條舊訊息前面，新的永遠抓不到**。當天剛好有 20 條語音／換聲測試訊息夾在中間，直接把水位堵死。
- 表現就像「她忽然不理人」：tick 每分鐘跑一次、每次都回 0 條、不報錯。

## 修法

- `src/discord-lane.js`：`fetchNew()` 改走新的純函式 `fetchPages({ fetchPage, startCursor, pageSize = 100, maxPages = 5 })`，分頁抓到不足一頁為止；**不再在抓取層過濾 bot 訊息**，交給 tick 推水位。`limit` 由 20 提到 100。
- 同一批補上三件「卡住時至少看得出來」的東西：
  - `withTimeout(promise, ms, label)` 包 `api.sessions.prompt`（30 秒）與 `api.sessions.list`（20 秒）。DSH 的 HTTP 沒有內建逾時，卡住時 tick 會永遠停在原地、連輪詢都不再跑。
  - `start()` 改成**先 `setInterval` 再跑第一輪**（`tick().catch(...)`），第一輪卡住至少 60 秒後還會再試。
  - tick 每輪加 3 分鐘的 `hangAlarm`，卡住時留一行「這一輪已經跑了 3 分鐘還沒完」；收到訊息時也留「收到 N 條，開始跑一輪」。`LANE_TRACE=1` 時額外印 `fetchNew 開始/回來`、`runTurn 開始/回來`。

## 驗證

- 修前：`fetchNew 回來，0 條`（每分鐘）＋水位不動。
- 修後（08:04:47）：`fetchNew 回來，28 條` → `收到 2 條，開始跑一輪` → `回了 上午不順 一句`；DM 收到「早安～」「去吧，我再窝一会儿」「路上小心噢」三條；`state/discord-lane.json` 的 `lastMessageId` 前進到 `1570590252610093130`。
- `scripts/test-discord-lane.mjs` 第 22 組：三頁 100/100/28 全收（游標 99→199→299）、不足一頁就停、`maxPages` 防呆；22 組全過。

## 影響面 / 遺留

- 影響：所有「積壓超過一頁」的情況（測試訊息多、離線一晚、DSH 重啟後補抓）都會中，不只這次。
- 遺留：`config.json` 的 `dsh.baseUrl` 仍會被 DSH 重啟打回舊值——現在靠 lane 自己的探測 + 看門狗重啟時帶 `DSH_WEB_URL`；兩者都失效時還是得手動改。

## 補記（08:12）：DSH 換端口後自己接回來

上面第 1 層根因（端口過期）補了兩件事，不用再手動改 `config.json`：

- `refreshApi()`：`resolveBaseUrl()` 重新探測，換了就丟掉快取的 API client、記一行「DSH 位址換了，改用 …」。
- `runTurn()` 送 prompt 時若遇到網路類錯誤（`fetch failed` / `ECONNREFUSED` / socket hang up…），先 `refreshApi()` 再重試一次，日誌「prompt 連不上（…），重新找 DSH 位址」。非網路錯誤（例如 prompt 被拒）不重試，照舊拋出。

驗證：`node --check` + `test-discord-lane` 22 組；重啟後 08:11:44 正常起步。

