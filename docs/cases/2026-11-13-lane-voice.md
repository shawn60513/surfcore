# 2026-11-13 讓她有聲音（離線 SAPI，不靠雲端）

## 為什麼

B站 上養魚圈公認「像人」的六個部件：記憶、主動搭話、心情、刷片、QQ 橋、**聲音**。
前五個我們都有了，只缺聲音——她只能打字。

## 走過的路（記下來免得再踩）

1. **Edge 在線 TTS（WebSocket）**：微軟 `speech.platform.bing.com` 現在要 `Sec-MS-GEC` 防濫用參數（Windows 時間戳 × 10⁷ + token 的 SHA-256），照 python `edge-tts` 的算法補上後仍然 **403**。換 `api.msedgeservices.com` 也 403。推測跟本機時鐘（系統時間 2026-11）與微軟 DRM 校時對不上有關，不值得繼續硬碰。
2. **`@memef1f1y/dsh-plugin-tts` 0.7.2**：裝進 profile 了（`pnpm add`），它走的是同一套 Edge 服務（同樣會 403），而且要重啟 DSH 才有 `/dsh-tts-api/speak` 路由。**留著但不啟用**（沒有加進 `dsh.profile.bundles`），將來說不定能用。
3. **Windows SAPI（採用）**：`System.Speech.Synthesis` → `SetOutputToWaveFile`，聲音是 `Microsoft Hanhan Desktop`（zh-TW 女聲），**完全離線**、沒有 key、沒有校時問題。實測 5 個字的句子 442ms 出 140KB wav。

## 實作

- 新 `src/tts.js`：`speakableText()`（去程式碼/連結/markdown）、`shouldSpeak()`（太長、純 emoji 不唸）、`pickSpeakLine()`（只唸最後一句）、`sapiScript()`（組 PowerShell，引號轉義、rate/volume 夾範圍）、`synthesizeWav()`（spawn `powershell.exe -NoProfile -NonInteractive`，逾時 kill，回檔路徑；錯誤碼 `tts.empty-text` / `tts.spawn` / `tts.timeout` / `tts.exit` / `tts.empty`）。
- `src/discord-core.js`：新增 `discordUpload()`（multipart：`payload_json` + `files[0]`，429 重試一次）；`sendMessage()` 收 `file` 選項——有附件時允許空正文，`allowed_mentions` 照樣壓住 `@everyone`。
- `src/discord-lane.js`：`send()` 送完文字後呼叫 `maybeSendVoice()`——依 `discord.lane.voice` 設定（預設開啟、35% 機率、只唸 ≤60 字的句子），合成 `aimisi.wav` 上傳，然後刪暫存檔。語音失敗只記一條 log，**不影響文字**（文字早就送到了）。
- `config.json`：`discord.lane.voice = {enabled:true, chance:0.35, maxChars:60, rate:2}`；`config.example.json` 是 `enabled:false`（範例預設不吵人）。

## 驗證

- `scripts/test-tts.mjs`（新，7 組）：挑句、該不該唸、去雜訊、PowerShell 轉義與夾範圍、合成成功（假 spawn）、空字拒絕、退出碼非 0、逾時會 kill。
- `scripts/test-mcp-discord.mjs` 加 5f：附件走 `multipart/form-data`、`payload_json` 的 `allowed_mentions.parse` 仍為空、檔案真的有帶上。
- 真機：用 `createDiscordClient().sendMessage(DM, { file })` 直接發過一條語音（message id `1570535411539779634`），Discord 端能播。
- `test-audit` **150/150**。

## 邊界

- 聲音是微軟的 Hanhan（台灣女聲），不是她自己的聲線；要「專屬聲音」得走 RVC/CosyVoice 那類模型（插件支援，但要另外裝服務）。
- 一次只唸最後一句：整段唸會像有聲書，不像在聊天。
- wav 檔案比 mp3 大（約 140KB/5 字），但 Discord 能吃，省掉轉檔依賴。
