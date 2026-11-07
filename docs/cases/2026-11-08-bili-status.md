# 2026-11-08 B站 例行状态摘要（bili-status）

## 现象
排查「她今天怎么没刷片」只能翻 `~/.dsh/bili-duty/state.json`、`seen.md`、`config.json` 三个文件加猜。

## 根因
没有一行命令的只读摘要；判重表有多大、今天跑了几轮、发动态开关状态分散在三个文件里。

## 修法
- 新增 `src/bili-status.js`：纯函数 `loadBiliDutySnapshot({dutyDir})`（读 config.json / state.json / seen.md，全部容错）、`countSeenBvs(seen)`（只取 `## 看过的视频` 一节，遇下一个 `##` 停）、`formatBiliStatus(snap)`；文件被 `node src/bili-status.js` 直接执行时打印摘要（用 `process.argv[1]` 判 CLI，避免 import 即打印）。
- 新增 `scripts/test-bili-status.mjs`（9 项：空目录不炸、摘要内容、判重只认章节、发动态开着有 ⚠️、默认目录指向 ~/.dsh/bili-duty），登记进 `scripts/test-audit.mjs`。
- `~/.dsh/bili-duty/config.json` 的 `scanPrompt` 追加质量门槛一行：「默认跳过『播放量 < 5 万 且 发布超过 3 天』的视频（除非方向里明确点名）」。

## 验证
- `node scripts/test-bili-status.mjs` 9/9；`node scripts/test-audit.mjs` 149/149。
- 真机 `node src/bili-status.js`：自动刷 valley、判重 20 个 BV、今天 count=1/picked=1、发动态：关。

## 遗留
- 摘要只覆盖 `~/.dsh/bili-duty`（插件栈）；surfcore 自己的 `bili.config.json` 生物钟状态不在此列（生物钟已停用）。
- 判重表正则只认 `BV[0-9A-Za-z]{10}`，短链/av 号不统计。
