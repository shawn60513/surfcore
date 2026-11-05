# 2026-11-05 · 让「愛彌絲」能在 B站 评论区 @ 人

## 现象
用户在 Discord 里问：「小愛的B站還是不能@我，他說只能看账号、看关注、看我@她、关注人」。

也就是说：agent 手里只有 `bili_account` / `bili_followings` / `bili_mentions` / `bili_follow` 四把工具，
**没有任何"在 B站 说话"的入口** —— 她能读到有人 @ 她，却没法回一句、更没法主动 @ 回去。

## 根因
`src/mcp-bili-safe.js` 当初是按「只读 + 关注」设计的（见 case `2026-11-05-bili-safe-mcp.md`），
写类动作只做了 `follow`。B站 的「@ 某人」不是独立接口，而是**发评论时把 `@昵称` 写进正文**，
所以缺的其实是「发评论 / 回复评论」这一把工具。

## 完整逻辑（改动）
1. `src/bili-core.js`
   - `loadBiliConfig()` 增加 `allowComment`（默认 **false**，对外发言必须显式开）。
   - 新增 `sanitizeComment(text)`：去控制字符（接口收到会 412）、trim、空 → `bili.empty-comment`、>1000 字 → `bili.comment-too-long`（B站 上限 1000，不静默截断）。
   - 新增 `userName(uid)`：`GET /x/web-interface/card?mid=` 取昵称 —— B站 评论里的 @ 是**纯文本匹配昵称**，不是 ID。
   - 新增 `resolveAid({bvid, aid})`：`GET /x/web-interface/view?bvid=` 换 aid（评论接口只认 aid）。
   - 新增 `comment({bvid, aid, message, mentionUid, root, parent})`：`POST /x/v2/reply/add`，body `{type:1, oid, message, plat:1, csrf:bili_jct}`，楼中楼加 `root`/`parent`；`mentionUid` 给了就先查昵称、正文没以 `@昵称` 开头就自动补在最前。
2. `src/mcp-bili-safe.js` 增加工具 `bili_reply`（bvid/aid 二选一、message、mentionUid、root、parent）。
3. `scripts/test-bili-safe.mjs` 新增 6 项：未开 `allowComment` 拒绝、bvid→aid、自动 @、已 @ 不重复、超长拒绝、空白拒绝；stdio 断言从四个工具改成五个。

## 验证
- `node scripts/test-bili-safe.mjs` → 全部通过（22 项）。
- `node scripts/test-audit.mjs` → 147/147。
- 真机发评论**未做**：B站 账号 `舜的大肥魚` 目前未绑手机，`/x/member/web/account` 不返回 `tel`，写类接口（动态/评论）大概率会被拒；这一步要用户先绑手机，再拿一条视频做一次真实 `bili_reply` 才算闭环。

## 遗留
- `bili_reply` 只支持 `type=1`（视频）。要回动态（`type=11/17`）需要再加参数。
- 「@ 到人」依赖昵称完全一致；对方改名后旧昵称的 @ 不会触发通知 —— 每次现查 `card` 就是为了避开这个坑。
- 运行中的 MCP 进程仍是旧代码，**要重启 DSH** 才会出现 `bili_reply`。
