# 她會發表情包了：Discord 附件通道

**日期**：2026-11-13
**症狀**：用户問「能不能讓小愛發表情包／迷因圖」。她只能打字，`mcp__discord__discord_send_message` 只有 `content`，沒有附件。

## 三條路，最後只走一條

| 方案 | 能不能做 | 結論 |
| --- | --- | --- |
| 自訂 Discord 表情（`<:名:id>`） | bot 缺 `MANAGE_EMOJIS_AND_STICKERS` | 用户說「b不用」，放棄 |
| 生圖（畫一張） | DeepSeek 沒有生圖 API；`dsh-image-gen` 要自備 provider | 用户說先不做 |
| **附件上傳** | bot 有 `ATTACH_FILES` | ✅ 就是這條 |

## 做了什麼

1. **裝 dsh-meme**（`dsh-meme@0.1.80`，desktop profile，也寫進 `dsh.profile.bundles`）：內建「大肥魚」圖庫 24 張，工具 `meme_list` / `meme_update` / `send_meme`。
2. **`src/discord-core.js` 新增 `loadAttachment(file, { allowedRoots })`**：把本地圖片讀成 `{ name, data, contentType }`。三條限制都是有意的：
   - 必須**絕對路徑**（相對路徑受 cwd 影響，發錯東西沒人知道）；
   - 必須在 `allowedRoots` 裡（`~/.dsh/meme-packs`、`~/.dsh/profiles`（插件圖庫就裝在這）、本項目 `state/`、`assets/`）——不然一句「把 C:\…\xxx.png 發出去」就能把任意本機圖片外傳；
   - ≤8MB、只收 png/jpg/jpeg/gif/webp。
   - 錯誤碼：`discord.bad-file` / `discord.file-not-allowed` / `discord.no-file` / `discord.file-too-large`，每個都帶 hint。
3. **`src/mcp-discord-safe.js` 的 `discord_send_message` 加 `file` 參數**：`loadAttachment` → `client.sendMessage({ content, file })`；帶圖時 `content` 可以留空（`src/discord-core.js` 的 `sendMessage` 早就支援「只有附件、沒有文字」——語音就是這樣發的，只是這條路一直沒接出來）。
4. **`LANE_WORKSPACE_RULES` 加一條**：「想發表情包：先用 `meme_list`（或 `send_meme`）挑一張，拿到它的 `path` 之後用 `discord_send_message` 帶 `file=` 發出去；氣氛到了才發，別連發，發完配一兩句就好。」

## 驗證

- `node scripts/test-mcp-discord.mjs`：新增 **5f**（附件走 multipart、`payload_json.allowed_mentions.parse` 仍為空、multipart 裡有檔案）與 **5g**（`loadAttachment`：白名單內可讀、相對路徑拒絕、非圖片拒絕、白名單外拒絕、不存在報 `no-file`、不給 roots 不限目錄）→ 全過。
- 真機：`deyi.jpg`（37,750 bytes）→ `sent true 1570579900811837502`（DM `1567777542910386347`）。
- 圖庫 path 在 `C:\Users\USER\.dsh\profiles\desktop\node_modules\dsh-meme\memes\dafeiyu-001\memes\…`，所以 `allowedRoots` 必須含 `~/.dsh/profiles`——第一版漏了，真機直接被 `discord.file-not-allowed` 擋。

## 遺留

- MCP server 是 DSH 啟動時 spawn 的，**新參數要重啟 DSH 才會出現在她的工具表**；在重啟之前她只能發文字（`send_meme` 仍會回 `[表情: 描述]` 標記，Discord 上不會變圖）。
- 表情包「主動斗圖」的判斷目前只寫在工作區規則裡（氣氛到了才發）；沒有做「按情緒自動挑圖」的程式邏輯。
- `dsh-meme` 的原生 IM 直發只支援 dsh-im（QQ/微信/飛書），Discord 走的是我們自己這條附件路。
