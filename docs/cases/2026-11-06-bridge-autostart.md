# 2026-11-06 · bridge 沒有自啟與看門狗，QQ 側也是一直空轉

## 現象

- `state/bridge.log` 每 2–4 秒一條 `SnowLuma 连接断开（code=1006），重连中…` + `token 自愈失败`，從 11-05 一路刷到 11-06。
- 使用者重開機、或 DSH 重啟把 bridge 進程帶走之後，Discord lane、B站 提醒、QQ 橋全都不會自己回來——但 GUI 裡仍然能跟角色聊，看起來「她還活著」。
- `qq_status` → `fetch failed`，QQ 側實際上啞了很久。

## 根因

1. **bridge 只有手動啟動**：沒有登入自啟，也沒有任何看門狗；`state/bridge.pid` 是上一次手動寫的，跟真實進程對不上（48380 vs 22088）。
2. **QQ 側沒有總開關**：`snowluma.enabled` 這個鍵根本不存在，程式永遠嘗試連 `ws://127.0.0.1:3001`，連不上就無限重連 + token 自愈，日誌被刷滿，也讓「bridge 是否健康」這件事失去訊號。
3. **QQ 側的定時器仍在跑**：`startPurposeLoop()`（每 60 秒想一遍）、`startProactiveScheduler()`（每 5 分鐘看要不要主動 @）、`syncStickerLibrary()`（啟動就同步收藏表情）與 QQ 無關地照跑，連不上時各自報錯。

## 修法

`src/bridge.js`：

- 模組級 `const QQ_DISABLED = (() => { … config.json 的 snowluma.enabled === false … })();`（`const ROOT` 之後）。
- `sendToQQ(key, msg)` 首行 `if (QQ_DISABLED) return;`。
- `bot.connect()` 改成 `if (QQ_DISABLED) { log('QQ 側已關閉…'); } else bot.connect()…`。
- `bot.on('close')` / `bot.on('error')` / `pollSnowlumaStatus()` / `reportSnowlumaHealth()` 各自 `if (QQ_DISABLED) return;`（SDK 仍可能自己嘗試連線，這裡不記帳、不彈窗、不自癒）。
- `startPurposeLoop()` / `startProactiveScheduler()` / `syncStickerLibrary()` 開頭 `if (QQ_DISABLED) return;`。
- `config.json` 的 `snowluma.enabled` 設 `false`；`config.example.json` 補 `enabled: true`（預設行為不變）。

`scripts/bridge-watchdog.ps1`（新增，**UTF-8 with BOM**，否則 PowerShell 5.1 用 ANSI 讀會把中文解析爛）：

- `Get-NetTCPConnection -LocalPort 3100 -State Listen` 有 → exit 0（埠在聽就是活著）。
- 沒有 → 若 `state/bridge.lock` 的 pid 還活著就 exit 0（避免跟正在啟動的進程打架），死了就刪鎖。
- `Start-Process … node.exe src/bridge.js -WindowStyle Hidden -PassThru`，4 秒後寫 `state/bridge.pid`，日誌追加 `state/watchdog.log`。

兩個計畫任務（免管理員、目前使用者層級）：

| TaskName | 觸發 | 動作 |
| --- | --- | --- |
| `surfcore-bridge-logon` | 登入時 | `wscript.exe "…\scripts\bridge-watchdog.vbs"`（VBS 內以隱藏視窗起 PowerShell） |
| `surfcore-bridge-watch` | 每 5 分鐘 | 同上 |

另外兩件小事（同批）：

- `C:\Users\USER\.dsh\speak-up-config.json`：`总开关: false`、`目标会话: []`（它原本指向已棄用的 `session-9efa6575`，注入的「念頭」只會讓她對著空氣說話）。
- `src/discord-lane.js`：新增 `const TONE_CARD = '（你自己的語氣：短句、直接、有點脾氣，別像客服。）';`，`replyPrompt()` / `proactivePrompt()` 各帶一句——`AGENTS.md` 只在會話開頭注入，DSH 壓縮後不保證重注入，這句是兜底（約 25 token/輪）。

## 驗證

- `taskkill` 掉 3100 上的進程 → 手動跑一次 watchdog → `state/watchdog.log` 出現 `清掉殘留的 bridge.lock（28820 已經不在了）` / `bridge 沒在跑，已拉起 PID 47284`，7 秒後埠重新在聽。
- 重啟後的 `state/bridge.log`（17:36:30）只剩：`QQ 側已關閉（snowluma.enabled=false）…`、`Discord lane 啟動…`、`記憶卡已載入（264 字）`、`B站提醒：已啟動`、`本地控制台已启动`——沒有任何 SnowLuma 行。
- 計畫任務：`Get-ScheduledTask -TaskName 'surfcore-bridge-*'` 兩個都是 `Ready`。
- `node --check src/bridge.js`、`test-discord-lane`（11 組）、`test-lane-memory`（11 組）、`test-mcp-discord`、`test-audit`（148/148）全過。

## 補記（17:57）：桌面每 5 分鐘閃一次命令提示字元

**現象**：計畫任務上線後，桌面不定時（其實是每 5 分鐘）閃一個黑框。

**根因**：任務動作直接是 `powershell.exe … -File bridge-watchdog.ps1`。`powershell.exe` 是**主控台程式**，
Task Scheduler 先為它建立 conhost，`-WindowStyle Hidden` 只是把視窗藏起來——建立的那一下還是看得到。

**修法**：加一層 GUI 宿主 `scripts/bridge-watchdog.vbs`（`WScript.Shell.Run(cmd, 0, False)`，視窗樣式 0 = 完全不建視窗），
兩個任務的動作改成 `wscript.exe "<路徑>\bridge-watchdog.vbs"`，並把任務的 `Hidden` 設 true。
另外看門狗改成**先寫「準備拉起」再起進程**，這樣即使進程半路死掉，日誌也知道它動過。

**驗證**：`Start-ScheduledTask surfcore-bridge-watch`（bridge 已被 kill）→ 18 秒後 `state/watchdog.log` 出現
`準備拉起 bridge（3100 沒在聽）` / `已拉起 PID 35972`，埠重新在聽；任務 `LastTaskResult=0`。

**注意**：VBS 用 ASCII/ANSI 存；`powershell.exe` 一定要寫絕對路徑
（`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`）——只寫 `powershell.exe` 時，
在部分宿主環境下 `sh.Run` 會靜默失敗（rc=0 但什麼都沒跑）。

## 踩過的坑

- PowerShell 腳本用 UTF-8 **無 BOM** 存檔，`powershell.exe`（5.1）按 ANSI 讀 → 中文變亂碼 → `Unexpected token '}'`。必須寫 BOM。
- `QQ_DISABLED` 只在啟動時讀一次設定：改了 `config.json` 要重啟 bridge 才生效（本專案一貫做法，因為 `loadConfig()` 也是啟動時讀）。
- `bot.on('close')` 的守衛要放在**第一行**：SDK 的 close 事件會連著觸發 `healTokenIfStale`，守晚了就還是會打一輪 token 自愈。

## 影響面

- 關掉 QQ 之後：`dsh-feiyu-mood` / 心情、`fish-memory`、B站 提醒、lane 都不受影響（它們不經過 `sendToQQ`）。
- 想開回來：`config.json` 的 `snowluma.enabled` 改 `true`，重啟 bridge（或等看門狗下一輪）。

## 補記（22:28）：看門狗自己彈了一個錯誤視窗，還把看片打斷

- 現象：桌面跳出 Windows Script Host 對話框「變數未定義: 'fso'」（行 3，程式碼 800A01F4）。
- 根因：VBS 用 UTF-8 存、裡面寫了中文註解 → WSH 按 ANSI(GBK) 解碼，雙位元組把換行吃掉 → 行號錯位、Dim 那行被併進註解 → Option Explicit 下 so 未定義 → **模態對話框**（搶焦點，全螢幕播放器會因此暫停）。
- 修法：
  1. VBS 只留 ASCII 註解，並加 On Error Resume Next：任何失敗只寫 state/watchdog-vbs.log，**絕不彈框**。
  2. 真正的檢查搬到 scripts/bridge-watchdog.mjs（純 Node）：連 3100 判斷活著、5 秒冷卻、清殘留鎖、spawn(process.execPath, ['src/bridge.js'], { detached: true, windowsHide: true, stdio: 'ignore' })；不再起 PowerShell，也就沒有 conhost。
- 驗證：cscript //nologo scripts/bridge-watchdog.vbs 無輸出；Get-Process 每 100ms 掃 9 秒確認 isible_windows=none；安靜時 95ms 結束；殺掉 bridge 後 VBS 拉回新 PID（22:29:09 起），全程沒有視窗。
