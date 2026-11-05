# 星汐档案混进了别的对话：绑定守卫 + 单一写手

- 日期：2026-11-06
- 影响面：`src/lane-memory.js`（新增 `foreignBindings` / `pruneForeignBindings`）、`src/discord-lane.js`（启动时摘除外来绑定、夜间整理可关）、`scripts/test-lane-memory.mjs`
- 版本：待发布（0.9.1 或并入 0.9.0）

## 现象

用户报：「小愛的記憶和現在這個聊天室（開發會話）的記憶混雜在一起。」

具体能看到：

- `~/.dsh/xingxi/会话/爱弥丝/日记/2026-11-06.md` 里写的是当天**开发对话**的内容（dsh-world、token 成本、Discord 照片修复）；
- `记忆卡.md` 的「五｜我们的约定」多出「记忆卡.md 是唯一真相 / 鱼の记忆只挂主会话」这类**设计结论**，还多了一节「2.1 我说话的方式」，例句标着（11-06）——那是我们聊代码时的句子，不是她跟对方说的话。

## 根因

1. 昨晚为了验证星汐能不能读卡，我把**本开发会话** `e03922e8-8f4c-4664-a872-8cf34ed3dbb3` 也写进了 `~/.dsh/xingxi/config.json` 的 `"绑定"`，指向同一个档案夹。
2. 星汐「拾星」的工作方式是：把**档案夹里绑定的每一个会话**的历史当素材，整理成档案。它不区分「这是角色的对话」还是「这是开发者的对话」——绑定即素材。
3. 于是 02:01–02:02 它跑完一批：写 `日记/2026-11-06.md`、往 `记忆卡.md` 的四章里追加内容，并留下备份 `记忆卡.md.bak-2026-11-05T18-02-20-301`（= 我手写的原版，3,137 字节）。

## 修法

1. **解绑并还原**：从 `config.json` 删掉开发会话的绑定；`记忆卡.md` 用拾星动手前的备份还原；删 `日记/2026-11-06.md`、`原始对话/2026-11-06.txt`、`.xingxi.json`、`.拾星/任务.json`、`.拾星/料`。
2. **启动时守卫**（`src/discord-lane.js` → `pruneXingxiBindings()`）：lane 每次启动，读星汐 `config.json`，把「指向本档案、但不是 lane 会话、也不是拾星工人（`.拾星/工人.json`）」的绑定**摘掉**，摘之前把 `config.json` 备份成 `config.json.bak-<时间戳>`，日志留一行：
   `Discord lane：星汐綁定裡混進了別的會話，已摘掉（拾星才不會把他們整理進她的檔案）：<id>（備份 …）`
   纯逻辑放在 `src/lane-memory.js` 的 `foreignBindings()` / `pruneForeignBindings()`，路径比较统一转正斜杠、小写，兼容 `C:/…` 与 `C:\…`。
3. **单一写手**：`shouldConsolidate()` 支持 `hour < 0` = 关掉；`config.json` 里 `discord.lane.consolidateHour` 设为 `-1`，夜间自动整理停用，改由拾星当唯一写卡者。日記仍照写（只记录，不写卡），lane 仍每轮读 300 字摘要。

## 验证

- `node scripts/test-lane-memory.mjs` → **9 组断言**（新增：`hour:-1` 关闭、外来绑定识别、真去改 config 时只摘外来者且留备份、干净时不动手）。
- `node scripts/test-discord-lane.mjs` → 9 组。
- `node scripts/test-audit.mjs` → **148/148**。
- 真机：手动往 `config.json` 注入假绑定 `session-foreign-test` → 重启 bridge → 日志出现「星汐綁定裡混進了別的會話，已摘掉 …（備份 config.json.bak-…）」，`config.json` 里只剩 lane 会话与拾星工人。bridge 现为 PID 44952。

## 遗留 / 注意

- 拾星是**重写**（不是增量），它跑一次会把整张卡按自己的判断重排；所以夜里它和 nightly 同时开就会重复记同一件事。目前 nightly 关着，要恢复就把 `consolidateHour` 改回 23，并想清楚谁写卡。
- 绑定守卫只管「指向本档案的会话」；如果有人把另一个**档案**的绑定写错成这个夹子，同样会被摘（因为路径相同），这符合预期。
- `~/.dsh/xingxi/config.json` 是星汐的配置，不属于本仓库，不进 manifest。
