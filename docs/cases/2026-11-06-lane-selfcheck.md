# 2026-11-06 · lane 自查：魚の記憶又開回來了、心跳沒有、pid 是假的

## 现象

用户问「幫我檢查從開始到現在有沒有什麼遺漏或是不足的以及幫我分析有沒有什麼地方有風險的」。
逐项自查（不是猜，全部落盘验证过），查出四件「现在就在错」和几件「迟早出事」：

1. **魚の記憶对当前 lane 会话语默认为开**。`C:\Users\USER\.dsh\fish-memory-config.json` 是
   `{ sessions: { session-539af9df…:false, session-ffd6814b…:false, session-ef58a582…:false }, switchMigrated:true }`。
   当前会话已经换成 `session-8d562f23-fb39-4d33-8cc7-11728e16265e`（人设重写时轮换的），不在表里；
   插件 `isEnabled()` 对「不在表里」的判定是**开**。也就是说这轮开始，鱼の记忆和记忆卡同时在往
   prompt 里塞记忆——正是 2026-11-05 那次「两套记忆说法打架」的老问题，换一次会话就复发一次。
2. **`state/bridge.pid` 是假的**：文件里写 `48380`，实际监听 3100 的是 `22088`。任何按 pid 文件
   停进程的脚本都会静默失败（`taskkill` 找不到进程，旧进程继续跑，新进程又被锁挡住）。
3. **B站 提醒没有心跳**：`src/bili-inbox.js` 只在「有新的」「推失败」「首次水位」三种情况打日志，
   正常空轮完全静默。`state/bili-inbox.json` 自 2026-11-05 19:16 之后没再写过，光看文件
   分不清「确实没人 @」还是「轮询早就死了」。
4. **`bili_reply` 没有把手机验证这道墙写进工具描述**：账号 `mobile_verified:0`，真调必然被 B站 拒
   （4126021 / 61001）。描述里只写「默认被 bili.allowComment 挡着」，模型会以为是配置问题反复试。
5. **心情插件的称呼是「伙伴 / 用户」**：`C:\Users\USER\.dsh\feiyu-mood\config.json` 的
   `selfName:"伙伴"`、`ownerName:"用户"`，每轮注入的情绪块和爱弥斯的人设不是同一个人的口吻。

## 根因

- 1 是**换会话没有配套动作**：会话 id 变了，但「哪些插件对这个会话开/关」是散落在各插件自己
  的配置文件里的，没人负责跟着改。lane 换会话只做了星汐绑定（2026-11-06 的绑定守卫），漏了鱼の记忆。
- 2 是 `state/bridge.pid` **不是 bridge 自己写的**（`src/bridge.js:1430` 只有 `bridge.lock`），
  是历次手动 `spawn` 的临时产物，重启后没人更新。
- 3 是日志设计问题：只记「有事」，不记「没事」，而「没事」恰恰是判断存活的那一半。
- 4/5 是同一种疏漏：改了人格与账号状态，但周边提示词/配置里的旧称呼与旧假设没跟着改。

## 修法

- `src/lane-memory.js` 新增导出 `pinFishMemoryOff(configFile, sessionId)`：读
  `~/.dsh/fish-memory-config.json`，把该会话写进 `sessions` 并置 `false`，改前备份
  `fish-memory-config.json.bak-<ISO>`；已经是 `false` 或文件不存在就什么都不做（返回 `{changed:false}`）。
- `src/discord-lane.js` `start()` 里，星汐绑定守卫之后紧接着调用它：
  `pinFishMemoryOff(path.join(USERPROFILE||HOME, '.dsh', 'fish-memory-config.json'), state.sessionId)`，
  改到了就打 `Discord lane：魚の記憶已對這個會話關掉（長期記憶走記憶卡，免得兩套說法打架）`。
  这样以后每次换会话（人设改、AGENTS 同步）都自动关，不用人记得。
- `src/bili-inbox.js`：加 `let lastQuietLog = 0;`，空轮时每小时最多打一条
  `B站提醒：看過一輪，沒有新的 @ / 回覆（seen N 條）`。
- `src/mcp-bili-safe.js`：`bili_reply` 描述末尾加「前提：账号要绑手机号，没绑会直接失败（4126021 / 61001），这时别再重试。」
- `C:\Users\USER\.dsh\feiyu-mood\config.json`：`selfName` → `愛彌絲`、`ownerName` → `上午不順`、`selfPronoun` → `我`。
- 当前会话的鱼の记忆已用一次性调用补上（`changed:true`，留了备份）；`state/bridge.pid` 改成真实 PID。

## 验证

- `node scripts/test-lane-memory.mjs` → **11 组**（新增第 11 组：新会话写进去且置 false、留备份、
  旧记录不动、`switchMigrated` 保留、已关不重复写、文件不存在静默）。
- `node scripts/test-discord-lane.mjs` → 11 组；`node scripts/test-bili-inbox.mjs` → 全过；
  `node scripts/test-bili-safe.mjs` → 全过；`node scripts/test-audit.mjs` → **148/148**。
- 真机：重启 bridge（旧 22088 → 新 **21604**，`state/bridge.pid` 同步），日志出现
  `17:10:48 Discord lane 啟動`、`記憶卡已載入（264 字）`、`B站提醒：已啟動`、
  `17:10:49 B站提醒：看過一輪，沒有新的 @ / 回覆（seen 3 條）` —— 心跳证明轮询活着，
  之前「静默 24 小时」确实只是没人 @。

## 影响面

只动 lane 的启动钩子、B站 提醒的日志频率、`bili_reply` 的描述文字和心情插件的三个称呼；
不改任何对外接口、不影响 QQ 桥与 B站 生物钟。`fish-memory-config.json` 每次改动都有备份。

## 遗留（本次没做，需要用户拍板）

- `feat/discord-mcp` 比 `origin/main` 多 **41 个提交**且没有 upstream：只存在本机。要不要推。
- bridge 没有开机自启/看门狗：DSH 重启或电脑重启后 lane 与 B站 提醒都不会自己回来。
- SnowLuma 一直 `code=1006`（`qq_status` → `fetch failed`）：QQ 侧现在是哑的，桥每 15 秒重连一次。
- `dsh-speak-up` 仍会对 lane 注入「念头」：现在不会被误投（lane 认轮），但会多烧一轮 token。
- 人设只在会话开头由 `AGENTS.md` 注入，压缩后是否重注入未验证；兜底（每 N 轮补 120 字语气卡）未做。

## 補記：第一版修法不夠（同一天 17:17 抓到的）

第一版只在 `start()` 裡釘一次，重啟後檢查發現 `session-8d562f23` 又變回 `true`，而且
`pinFishMemoryOff` 在 17:10 那次啟動並沒有觸發（日誌裡沒有「已對這個會話關掉」那行）——說明
17:06 那次釘的 `false` 被蓋掉了。

來源：`dsh-fish-memory` 的「繼承記憶」（`lib/index.js:4585-4600`）——新會話的庫是空的、
而來源會話有記憶時，它會把記憶複製過來，並執行
`if (isEnabled(来源)) setEnabled(sid, true)`（`:4599`）。lane 會話是新建的、庫是空的，
正好命中這條，所以任何一次「新會話」都會把開關重新打開。

改法：把釘子挪到 `tick()` 開頭（每一輪都先釘），並且只在真的翻轉時打
`Discord lane：魚の記憶又被打開了，已再關掉`。這樣就算插件哪天又自己開，最多一個輪詢週期
（60 秒）內會被關回去，而不是等到下一次重啟。

驗證：重啟（PID 28820）後等 75 秒跑過至少一輪 tick，`fish-memory-config.json` 裡
`session-8d562f23` 穩定為 `false`，日誌沒有出現「又被打開」。
