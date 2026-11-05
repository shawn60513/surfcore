# 新增 B站 safe MCP：在一轮对话里看「关注了谁」「谁 @ 了我」

日期：2026-11-05

## 现象

- 用户：「看不到小愛在B站關注和@我怎魔辦」（m00864 确认「小愛=舜的大肥魚」）。
- 具体表现：DSH 里问「小愛关注了谁」「小愛被谁 @ 了」，只能得到含糊回答或干脆没法查；
  `bili_*` 工具表里根本没有这两个动作。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows / DSH desktop profile（Web GUI `http://127.0.0.1:13590`） |
| SurfCore 版本 | dev，分支 `feat/discord-mcp` |
| B站 账号 | `舜的大肥魚`，uid `3747579670040322` |
| 凭证 | `C:\Users\USER\.dsh\bili-duty\bili_credential.json`（`sessdata` / `bili_jct` / `buvid3` / `dedeuserid`） |
| 已有 B站 能力 | `dsh-bili-subagent` 插件（14 个工具）+ 其 `vendor/bilibili-mcp/mcp_server.py` |

## 根因

不是登录坏了，也不是 B站 没数据，而是**工具面缺口**：

1. 宿主的 `dsh-bili-subagent` 只暴露了 取稿/发评论/扫码/扫描 这类「生产」工具，
   **没有**「关注列表」和「@ 我」两个只读动作。
2. 它自带的 Python MCP 里其实有 `bili_received_at_and_likes`（`mcp_server.py:1696`）、
   `bili_received_replies`（`:1678`）和 `bili_dm_*`，但没桥接到宿主工具面，会话里调不到。
3. `inboxOn: true` 只是在谷时（12–14、18–09）每 120 分钟扫一遍再提示会话去回，
   且 `targetSession` 为空 —— 那是「后台推送」，不是「我现在想看一眼」。

结论：与其改 `node_modules` 里的插件（升级即丢），不如在 surfcore 里加一个**同构的只读 MCP**。

## 完整逻辑

数据面（全部官方 web 接口，走浏览器同款 cookie）：

| 动作 | 接口 | 说明 |
| --- | --- | --- |
| 我是谁 | `GET /x/web-interface/nav` | 拿 `mid` / `uname` / `coins` / `level` / `follower` |
| 关注了谁 | `GET /x/relation/followings?vmid&pn&ps&order=desc` | `data.list[]`，按关注时间倒序 |
| 谁 @ 我 | `GET /x/msgfeed/at?build=0&mobi_app=web` | `data.items[]`，`at_time` 是秒级时间戳 |
| 谁回我 | `GET /x/msgfeed/reply` | 同上 |
| 谁赞我 | `GET /x/msgfeed/like` | 同上 |
| 关注 / 取关 | `POST /x/relation/modify` | body `{fid, act: 1\|2, re_src: 11, csrf: bili_jct}` |

实现分两层，和 Discord MCP 同构：

1. `src/bili-core.js` —— 纯引擎，不碰 stdio，可离线单测：
   - `loadBiliConfig(root)`：读 `config.json` 的 `bili` 段，clamp 超时与条数。
   - `readCredential(file)`：缺 `sessdata` 或 `bili_jct` 就当没登录（`bili.no-credential`）。
   - `biliRequest()`：统一超时、状态码映射、`code != 0` 映射；`-101` 提示重新扫码，`-352` 提示风控。
   - `createBiliClient()`：`me / followings / mentions / follow`。
   - **对外动作 fail-closed**：`follow` 必须 `bili.allowFollow === true`，否则 `bili.follow-disabled`。
2. `src/mcp-bili-safe.js` —— stdio MCP（serverName `bili-safe`），4 个工具：
   `bili_account`、`bili_followings`、`bili_mentions`、`bili_follow`。
   每次调用**现读凭证**，重新扫码后不用重启 DSH。

## 修法

- 新增 `src/bili-core.js`、`src/mcp-bili-safe.js`、`scripts/test-bili-safe.mjs`。
- `config.json` 加 `bili` 段（本地，gitignore）：`enabled: true`、`credentialPath`、`allowFollow: false`。
- `config.example.json` 加同段样例（默认 `enabled: false`、`allowFollow: false`）。
- `scripts/setup-dsh.mjs:186` 的 `MANAGED_MCP_IDS` 与 `:195` 的 servers 各加一条，
  下次 `setup:dsh` 不会把它抹掉。
- `C:\Users\USER\.dsh\profiles\desktop\cordis.patch.yml` 手工插入 `mcp-bili-safe`（serverName `bili-safe`），
  备份在 `_backups/cordis.patch.yml.<stamp>.bak`。
- `scripts/test-audit.mjs` 与 `scripts/test-mcp-servers-stdio.mjs` 登记新测试。

## 验证

```text
node scripts/test-bili-safe.mjs          # 16 项全过（含 nickname 回归）
node scripts/test-mcp-servers-stdio.mjs  # 5 个 MCP server 全部接入（bili-safe 4 工具）
node scripts/test-audit.mjs              # 146/146
```

真机（工具表已热加载 `mcp__bili-safe__*`，无需重启）：

```text
bili_account      → 舜的大肥魚 / uid 3747579670040322 / loggedIn true / coins 1 / level 2
bili_followings   → total 0（确实一个人都没关注）
bili_mentions at  → total 1
                    uid 23388718，标题「非正文 设定图（随剧情更新）」
                    https://t.bilibili.com/1236020553387606024
```

踩过的坑：`/x/msgfeed/*` 的 `user` 字段只有 `nickname`，没有 `uname`；
`normalizeUser` 一开始只认 `uname`，导致 `user` 显示为空。
已修成 `u.uname ?? u.nickname`，并补了回归断言（fixture 只带 `nickname`）。

## 遗留 / 后续

- `bili_follow` 默认关着（`allowFollow: false`）。要真的关注人得先改配置，
  属于对外动作，**必须先问用户**再打开。
- 目前只读「关注列表 / @我 / 回复我 / 点赞我」，没有私信（DM）与动态流。
- 没做分页游标之外的增量同步（每次全量拉一页）；条数上限 100。
- 关注列表为空是**真实状态**，不是接口问题 —— 若用户以为关注过谁，先确认是不是另一个账号。
