# 她能不能看 YouTube / IG Reels

- 日期：2026-11-06
- 现象：用户问「能跟小愛分享 ig reels 和 youtube 影片嗎」。
- 结论：**能**。YouTube 与公开的 IG Reel 都可以让她真的看画面（不是只看标题），但需要两件事：本机有 `yt-dlp`，以及她知道「收到链接要去看」。

## 当时的状态

- `video_probe` / `video_storyboard` 已经装好（`dsh-video-storyboard@0.6.8`），但只支持「本地文件或 B站 链接」——**YouTube / IG 走 yt-dlp，而本机没有 yt-dlp**，所以第一次调用直接报
  `Error: yt-dlp not found. Install one of: pip install --user -U yt-dlp / winget install yt-dlp …`。
- 她的 lane 会话里 `video_*` 工具是有的（session 的 `request/context` 里能看到 schema），只是没被提示该用。
- 顺带发现：那次测试她把「发给模型的提示词」整段抄回给了 Discord（见下一节）。

## 修法

1. **装 yt-dlp 到已在 PATH 上的目录**，这样不用重启 DSH 也能被找到：
   从 GitHub releases 下载 `yt-dlp.exe`（22.5 MB，2026.10.26）到
   `C:\Users\USER\AppData\Local\Microsoft\WindowsApps\yt-dlp.exe`——该目录本来就在 PATH 里，而且当前用户可写。
   （官方推荐的 `pip`/`winget` 都行，本机没有 Python，winget 装的 shim 也需要重启宿主才生效，所以直接放文件。）
2. **在 lane 的 prompt 里加链接提示**（`src/discord-lane.js`）：
   ```js
   const LINK_HINT =
     '（這則裡有連結：先用 video_probe 看它多長，再用 video_storyboard 真的看畫面；看完說你看到什麼。IG 若被登入牆擋住就直說看不到，別裝作看過。）';
   const hasLink = (text) => /https?:\/\/\S+/i.test(String(text ?? ''));
   ```
   `replyPrompt()` 末尾按 `hasLink(text)` 决定加不加这一行。只对「这一条消息里带链接」的轮次生效，不常驻、不增加平时的 token。
3. **镜像只发最后一句话**（同文件，`consumeEvents` 的镜像个槽）：原本把这一轮所有 `assistant/message` 文字用 `\n` 拼起来，于是工具调用前那句「（Discord 私訊）直接給聊天內容…」——模型把提示词抄了一遍——也被送进 Discord。改成 `slot.text = piece`（后写的覆盖前面的），`turn/end` 时只发最后一段。

## 验证

- `yt-dlp --version` → `2026.10.26`；`video_probe https://www.youtube.com/watch?v=aqz-KE-bpKQ` → 标题 *Big Buck Bunny*、635 秒、最高 2160p。
- `video_probe https://www.instagram.com/reel/C2mwxDYvQju/` → 标题 `Video by muradosmann`、最高 1280p（匿名可读）。
- 真机让她看 YouTube：她调了 `video_probe` + `video_storyboard`，回「看了，六百三十五秒。」「开头先让一朵粉色的云慢慢推过去……兔子第二次露脸是趴在自己洞口闻味道」。
- 真机让她看 IG Reel：回「看到了，十六秒从头到尾就一个镜头。」「沙丘脊上站着一人，穿黑长裙……左边是海，浪一层层翻白」「这是 muradosmann 的号，那个「Follow Me To」」。
- 修完镜像后重跑，Discord 里只剩这两三句回答，没有再出现提示词。

## 影响面 / 边界

- **只有公开内容能匿名看**。私密账号、需要登录才可见的 Reel 会失败；`yt-dlp` 支持 `--cookies`，`video_storyboard` 也有 `cookies` 参数，但 lane 现在不传——要支持的话得先有一个导出的 `cookies.txt` 路径（放 config，别进 repo）。
- 她看的是**抽帧宫格 + 字幕**，不是逐帧视频；细节要靠 `video_zoom` 再看一次（每次多花 2–4K token）。短 Reel 一次宫格就够。
- 工具是「她自己去调」的，不是用户发链接就自动下载。若哪次她不看就答，问题在提示而不是工具。
