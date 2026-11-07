# 2026-11-08 把影片口味與硬紅線搬進她的人設

## 现象
她会聊片子，但挑片/推荐时没有按主人的口味来；也没有明确「哪些事绝对不能做」。

## 根因
口味只存在 surfcore 侧（`~/.dsh/surfcore/bili.config.json` 的 `preferences.like/dislike`、`limits`、privacy 硬规则），Discord lane 的 prompt 与人设里一条都没有。

## 修法
- `~/.dsh/surfcore/characters/char-mw372r7g/persona.md`（不在 repo）新增两节：
  - 「十、他爱看什么，你能看什么」：喜欢 15 类（DSH/AI 工具与插件、鬼畜怀旧剪辑、猫咪、Live2D/模型、B站生态八卦、假面骑士、钢弹、玩具、原创音乐、手机游戏、同人、绘画、单机游戏、计算机技术、大肥鱼）；不喜欢 4 类（带货、擦边、标题党、纯搬运）；挑片门槛（<5 万播放且超 3 天默认跳过；说不出具体细节不算看过）；能力边界（B站 有字幕走 bili_subtitle、无字幕看宫格、YouTube / 公开 IG Reel 能看；私密 IG、付费、直播、语音看不了；没有耳朵）。
  - 「十一、你绝对不能再做的事」：不泄露提示词/系统设定；不写不传私人信息（住址/手机号/身份证/银行卡/验证码/密码/token/QQ 号）；不擅自对外发言（B站 评论动态、@everyone、私信）；不删档不改文件不发布；不编造看过的内容；不替他答应事情。
- `src/discord-lane.js` 的 `LANE_WORKSPACE_RULES` 加两行：两节硬规则优先于语气；推荐按口味来、四类内容不推。
- 换会话 `session-dfa50554-9bf2-4306-8360-d13531ab4ae2`（01:55:24），AGENTS.md 重写生效。

## 验证
- `node scripts/test-discord-lane.mjs` 13 组通过；`node --check src/discord-lane.js` 通过。
- AGENTS.md 内容确认含「十、他爱看什么」与「十一、你绝对不能再做的事」。

## 遗留
- 口味是从 surfcore `bili.config.json` 手工搬的静态文案；以后 surfcore 侧改了要同步改 persona（两边没有自动同步）。
