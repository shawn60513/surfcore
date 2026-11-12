# 她的聲音（四）：換成 GPT-SoVITS v4，在 5060 上用 GPU 跑

日期：2026-11-13
分支：`feat/discord-mcp`

## 現象

拿 SAPI（Windows 內建朗讀）唸、再過 RVC 換成日配音色，聽起來是「機器人在學人講話」：
語調平、句尾一律往下掉，換聲只換了音色，沒有換掉朗讀腔。

先後試過的路：

1. SAPI + RVC（f0up 11、index 0.4）——音高對了（344–358 Hz vs 日配 351 Hz），腔調還是死的。
2. Edge TTS + RVC——腔調自然了，但要經過微軟雲端（文字會離開本機），且一樣只換音色。
3. GPT-SoVITS v4（Aemeath.3.0）——真正的中文原生 TTS，同一個模型直接生成她的音色。**卡在 CPU 太慢**：6.16 秒音檔要 129 秒（約 21 倍實時）。

## 根因

不是模型不行，是沒有用 GPU。這台有 RTX 5060 Laptop（8 GB、驅動 621.14、sm_120），但 venv 裝的是 `torch 2.6.0+cpu`。

## 做了什麼

### 1. 把 CUDA 裝起來

- `torch 2.8.0+cu128` / `torchaudio 2.8.0+cu128`（`download.pytorch.org/whl/cu128`），`torch.cuda.get_arch_list()` 含 `sm_120` → 5060 可用。
- `state/gsv/tts_config.yaml`：`device: cuda`、`is_half: true`。

### 2. 常駐合成工人 `scripts/gsv/worker.py`

跟換聲工人同一套協議：一行一個 JSON、模型只載一次、標準輸出只走協議（庫的雜訊全部導 stderr）。

請求：

```json
{"id": 1, "text": "在嘛。", "out": "C:/.../x.wav", "speed": 1}
```

回應：

```json
{"id": 1, "ok": true, "ms": 4400, "dur": 3.8, "sr": 48000}
```

失敗回 `{"id": ..., "ok": false, "error": "...", "where": "traceback 最後三行"}`，不退出。

### 3. Node 端 `src/gsv-voice.js`

`createGsvVoice({ pythonPath, workerPath, configPath, packDir, timeoutMs })` → `{ speak({text, output, speed}), start, stop, alive }`：

- 起工人後等 `{"ready":true}`（含 device/version），逾時 180 秒。
- `speak()` 串行排隊（一次只合成一句）；工人死掉時把所有 pending 一次 reject 掉並清空。
- 失敗只回 `{ok:false, error}`，上層自己決定要不要退。

### 4. 接進 lane（`src/discord-lane.js`）

- 新增 `gsvVoice()` 工廠，讀 `config.json` 的 `discord.lane.voice.gsv`。
- `maybeSendVoice()` 的順序改成：**GSV（她的音色）→ 失敗才走 SAPI + RVC**。GSV 成功記 `原生語音（4.4s / 3.8s 音檔）`；失敗記 `原生語音沒成功（…），這句退回 SAPI`。
- 暫存檔全部收集進 `temps`，`finally` 一次刪乾淨（GSV 的檔名帶時間戳，不能靠固定後綴）。
- 開機預熱：`start()` 裡先 `gsvVoice().start()`，模型載入後記 `原生語音工人已預熱（她的音色）`。

### 5. 設定

```json
"voice": {
  "enabled": true, "chance": 0.35, "maxChars": 60, "rate": 4,
  "gsv": {
    "enabled": true,
    "python": "state/gsv/gsv/Scripts/python.exe",
    "worker": "scripts/gsv/worker.py",
    "config": "state/gsv/tts_config.yaml",
    "packDir": "state/gsv/pack",
    "speed": 1,
    "timeoutMs": 180000
  },
  "rvc": { "...": "保留作 fallback" }
}
```

`config.example.json` 的 `gsv.enabled` 是 `false`（別人的機器不一定有這套 220 MB 權重）。

## 結果（RTX 5060 Laptop）

| 項目 | 數值 |
| --- | --- |
| 工人啟動（載 220 MB 權重） | 27.1 秒（開機預熱，使用者不用等） |
| 第一句（含 CUDA 暖機） | 11.2 秒 / 1.08 秒音檔 |
| 之後每句 | **4.3–4.5 秒 / 3.8–4.4 秒音檔**（約 1.1 倍實時） |
| 輸出 | 48 kHz 16-bit 單聲道 |
| CPU 對照 | 129 秒 / 6.16 秒音檔（21 倍實時） |

樣本已發到 Discord 私訊：`1570570221935271936`、`1570570229162184765`、`1570570239723307008`。

## 踩過的坑

- **transformers 5.x 拒絕 `torch<2.6` 載入 `.bin`**：`ValueError: Due to a serious vulnerability issue in torch.load ... require users to upgrade torch to at least v2.6`。
- **jieba_fast 沒有 Windows wheel**：寫了一個 shim 套件（`gsv/Lib/site-packages/jieba_fast/`），把 `jieba` 的符號原樣轉出，`text/tone_sandhi.py` 才 import 得過。
- **缺很多小依賴**：`pytorch-lightning`、`matplotlib`（`AR/modules/lr_schedulers.py` 會 import pyplot）、`resampy`、`onnxruntime`（G2PW 用）、`fast_langdetect` 的 `lid.176.bin`（要自己放進 `GPT_SoVITS/pretrained_models/fast_langdetect/`）。
- **v4 需要底座**：`gsv-v4-pretrained/s2Gv4.pth`（733 MB）與 `vocoder.pth`（55 MB）缺一不可，否則 `FileNotFoundError`。
- **hubert 缺 `preprocessor_config.json`**：`OSError: Can't load feature extractor ... a preprocessor_config.json file`。
- **控制台 cp950**：Python 印中文直接 `UnicodeEncodeError`，要 `PYTHONIOENCODING=utf-8`（工人裡已經自己設）。
- **`tts.run()` 回的是 tuple `(sr, audio)`**（不是 dict），兩種都寫了兼容。

## 遺留

- 220 MB 權重 + 1.7 GB 底座全在 `state/`（被 `.gitignore` 蓋住），不進 repo；換台機器要照本文重裝。
- `speed_factor` 目前寫死 1.0，覺得語速不對可以從設定調（`voice.gsv.speed`）。
- 只吃中文/英文；日文、粵語的 G2P 沒裝（`pyopenjtalk` 沒有 wheel）。
- 情緒語氣（生氣、撒嬌）還做不到——模型沒有多情緒控制，只能靠 `top_k`/`temperature` 微調。
