# 2026-11-08 影片口味與硬紅線：改成按需注入，不寫進人設

## 现象

她会聊片子，但挑片/推荐时没有按主人的口味来；也没有明确「哪些事绝对不能做」。

## 根因

口味只存在 surfcore 侧（`~/.dsh/surfcore/bili.config.json` 的 `preferences.like/dislike`），Discord lane 的 prompt 与人设里一条都没有；红线散落在 `plugins/surfcore/lib/privacy.js`，prompt 侧也没有。

## 第一版（走错了）

把口味和红线两节直接写进 `persona.md`（人设）。用户当场指出问题：

> 不能直接把功能加在插件中嗎直接寫在人設感覺會多耗token

这个反对是对的：人设是**每个会話都带着走的长文本**，把「只有在挑片时才用得上的东西」塞进去，等于每个会话、每一轮都替它付钱。而且口味会变（`bili.config.json` 随时能改），写进人设就是两份真相。

## 修法（第二版，插件侧按需注入）

- `persona.md` 删掉那两节（恢复到 3,466 字）。
- `src/discord-lane.js` 新增模块级导出：
  - `shouldOfferTaste(text)`：命中链接或 `TASTE_TOPIC`（推荐／看什麼／口味／片子／影片／刷到／好看／BV 号…）才 `true`。
  - `formatTasteLine(taste)`：把 `preferences.like` / `dislike` 拼成一行提示；`like` 为空返回 `''`。
- lane 工厂内 `TASTE_FILE()` 指向 `~/.dsh/surfcore/bili.config.json`，`readTaste()` 按 mtime 缓存读 `preferences`；`tasteHint(text)` 只在 `shouldOfferTaste(text)` 为真时返回那一行。
- `replyPrompt()` 在 `LINK_HINT` 之后插 `tasteHint(text)`；`proactivePrompt()` 插 `tasteHint('推薦')`。
- 红线仍然留在 `LANE_WORKSPACE_RULES`（「你絕對不能做的事」六条）——那是行为约束，每会话注入一次、跟着缓存走，成本可接受，也**不该**因为对话里没提片子就不生效。
- 换会話 `session-b3a26da0-30f5-46f9-a6ca-0389ab1d720f`（02:01:41），AGENTS.md 重写生效。

## 为什么这样更省

- 人设（AGENTS.md）每会話只注入一次，之后吃缓存前缀；把口味放人设＝每个会話固定多几百字。
- 现在只有**聊到片子/链接那一轮**才多约 120 字，其他轮次一个 token 都不花。
- 口味仍然是单一真相源：改 `bili.config.json` 立刻生效，不用重写人设、不用重开会話。

## 验证

- `scripts/test-discord-lane.mjs` 第 14 组：`shouldOfferTaste` 正例（BV 号／「推薦」／链接）、反例（「晚安」「今天吃什麼」）；`formatTasteLine` 列出愛看/不碰、空输入返回 `''`、`null` 不炸 → **14 组通过**。
- `node scripts/test-audit.mjs` → **149/149**。
- 真机日志：`02:01:41 Discord lane 會話已建立`、`新會話已綁回她的星汐檔案`、`魚の記憶已對這個會話關掉`。

## 遗留

- `state/bridge.pid` 又双叒是旧值（写的是 48984，真正监听 3100 的是 45360）；`EADDRINUSE` 之后才发现。以后重启一律先用 `Get-NetTCPConnection -LocalPort 3100` 拿真实 PID，再 kill。
- 红线目前只在 AGENTS.md（会話开头注入一次）。如果以后 DSH 压缩后不再重注入，需要兜底（每轮带一句极短的红线提示，或改用 PreToolUse 式拦截）。
