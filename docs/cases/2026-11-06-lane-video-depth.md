# 她看 B站「只有淺淺的看」：一次看不到 1 條、二次講不出細節

- 日期：2026-11-06
- 涉及檔案：`C:\Users\USER\.dsh\bili-duty\config.json`（使用者設定，不入 repo）、`state/discord-lane-workspace/AGENTS.md`（工作區指示，由 lane 生成）、`src/discord-lane.js`、`src/lane-memory.js`、`scripts/test-lane-memory.mjs`
- 建議版本：0.9.1 patch

## 現象

使用者（m03741）：「為什麼小愛看B站都只有淺淺的看而已」。她在 Discord 私訊裡分享片子時，只有一兩句話（「影之刃零那个啊，BV1QH4h6kERj。评论区最热闹的是那句…」），聽起來不像真的看過。

先確認不是「讀得淺」：`C:\Users\USER\.dsh\bili-duty\out\2026-11-05.md` 有 9 條、9,269 字；`2026-11-06.md` 有 4 條、10,617 字；每條 700–1,700 字，結構是「講了什麼／為什麼值得／評論區反響」＋檔位。連無字幕的手書（BV1HVxJ6xEta）都寫明「靠置頂歌詞＋簡介＋評論區還原」。

## 根因（四層，每層砍掉一部分）

1. **一輪只挑一條**：`dsh-bili-subagent` 的 `perScan: z.natural().default(1)`（註釋「一次挑一條更清爽，默認 1」）→ `bili_scan` 每輪只交 1 條；11-05 跑 9 輪才有 9 條，11-06 只有 4 輪＝4 條（`state.json` 的 `count/picked` 也是 4）。
2. **沒字幕的直接跳過**：`dsh-bili-subagent` 的預設 `SCAN_PROMPT_TMPL`（:2803）寫死「沒字幕的就跳過」→ 手書、PV、純音樂全被淘汰，留下來的大多是口播評測。
3. **千字報告到她嘴邊只剩兩三句**：報告落在 `out/<日期>.md`，只在那一輪讀一次；lane 每輪只帶 24 條歷史（`src/discord-lane.js` `HISTORY_LIMIT = 24`），工作區規則又要求「1–3 句、不要 Markdown」。
4. **判重表寫了卻沒餵給挑片的人**：`lib/seen.mjs` 的 `記刷過的(seen.md, bvs, date)` 在每輪結束後寫入，`seen.md` 目前 11 個 BV，但挑片提示詞不含該清單 → `BV13oFzzmEEg`、`BV1Vfxi6fE5n` 在 11-05 各被挑中兩次。

## 修法（四處一起改）

1. **A 一輪多挑**：`C:\Users\USER\.dsh\bili-duty\config.json` 的 `perScan` 由 1 改 **3**（這是使用者設定，落在 `~/.dsh/bili-duty/config.json`，不進 repo）。
2. **B 不許因為沒字幕就跳**：同一份設定的 `scanPrompt` 改成自訂版（713 字），要求：沒有字幕就看簡介＋置頂留言＋評論區，並註明「靠什麼還原」；每條固定寫「講了什麼／最關鍵的一個點（原話或數字）／爭議點」。手書、PV、純音樂不再被淘汰。
3. **C 分享時要說清楚**：lane 生成的工作區指示 `state/discord-lane-workspace/AGENTS.md` 增加一條「講 B 站 的片子時，不能只給編號和一句感想：要說清這條講了什麼、再補一個具體細節（原話、數字、或評論區在吵什麼）」。
4. **D 開掃前把刷過的塞進提示詞**：`src/discord-lane.js` 在組 `bili_scan` 提示時，把 `seen.md` 裡的 BV 清單（最近 20 個）一起帶進去，讓挑片的人自己避開。

## 額外修掉：換會話之後星汐斷綁

換 lane 會話（`session-ef58a582…` → `session-5586e2fb…`）時發現：綁定守衛只會「摘掉外來會話」，不會把新會話綁回去。結果舊會話被當成外來者摘掉，新會話又沒人綁 → 檔案悄悄停止生長，而且沒有任何報錯。

修法：`src/lane-memory.js` 的 `pruneForeignBindings()` 順手補綁——當前 `sessionId` 沒綁在 `folder` 上就加上去，返回 `{removed, added, backup}`；`src/discord-lane.js` 的 `pruneXingxiBindings()` 在補綁時打一行 `Discord lane：新會話已綁回她的星汐檔案（<sessionId>）`。

## 驗證

- `node scripts/test-lane-memory.mjs` → **10 組**（新增第 10 組：新會話補綁、舊 lane 會話被摘、仍留備份）。
- `node scripts/test-discord-lane.mjs` → 9 組。
- `node scripts/test-audit.mjs` → 148/148。
- 真機：重啟 bridge 後日誌 `16:10:38 Discord lane：新會話已綁回她的星汐檔案（session-5586e2fb-697c-401f-8ee9-ab5772febe38）`，`~/.dsh/xingxi/config.json` 的「绑定」同時有拾星工人與新 lane 會話，且都指向 `C:/Users/USER/.dsh/xingxi/会话/爱弥丝`。
- 換新 lane 會話（清 `state/discord-lane.json` 的 `sessionId`，保留 `workspaceId`）是為了讓新的 `AGENTS.md` 生效——工作區指示只在**新會話**開始時注入一次。

## 遺留 / 風險

- `perScan` 與 `scanPrompt` 是 `dsh-bili-subagent` 的外掛設定，**要重啟 DSH 才會被讀到**；下一次掃描時看 `duty.log` 是否一輪出 3 條。
- 她講得清不清楚沒有自動檢查；如果又變成只給編號，先看是不是 lane 又換了會話（AGENTS.md 沒重注入）。
- `seen.md` 的清單是「最近 20 個」，更早的仍可能被重挑。
- 本 case 只改「怎麼挑、怎麼講」，沒有動 B站 帳號本身（發評論仍要手機驗證）。
