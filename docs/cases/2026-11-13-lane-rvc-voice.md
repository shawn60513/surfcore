# 她自己的聲音：把 RVC 語音包接進來

**日期**：2026-11-13

## 需求

使用者丟了 `AemeathJP_e250_s7250_RVCv2_RMVPE.zip`（55 MB 的 `.pth` + 97 MB 的 `.index`），
問「能不能用」。目標是讓 Discord 私訊裡的語音不再是 Windows 內建的韓涵，而是愛彌斯的音色。

## 這個包是什麼

- `AemeathJP_e250_s7250.pth`：RVC **v2**、**40 kHz**、`f0=1`（帶音高）、250 epoch、
  訓練者資訊 `AVermedia Live Gamer EXTREME 2`；457 個張量，`enc_p.emb_phone` 是 `(192, 768)` → 768 維特徵（v2 的形狀）。
- `added_IVF791_Flat_nprobe_1_AemeathJP_v2.index`：FAISS 檢索索引，推論時用它把特徵往她的音色拉（`index_rate`）。
- 合起來是「聲音轉換」而不是「文字轉語音」——所以還是需要一個來源聲音（現在是 SAPI 韓涵）先唸出來。

## 硬牆：fairseq

官方推論鏈 `rvc-python` 依賴 `fairseq==0.12.2`（拿 HuBERT 特徵），這台機器的 Python 是 3.12，
fairseq 沒有 3.12 的輪子、也編不過。**沒有降級 Python**，改把 fairseq 那一段換掉：

- `scripts/rvc/infer_aimisi.py`：在匯入 `rvc_python` 之前塞一個空的 `fairseq` 模組，
  再把 `vc.utils.load_hubert` / `vc.modules.load_hubert` 換成 HuggingFace 的
  `lengyue233/content-vec-best`（同一份 HuBERT 的中文權重，只是 HF 版）。
  `extract_features(source, padding_mask, output_layer=12)` 回 `(hidden_states[12],)`，
  跟 fairseq 的回傳形狀一致，`pipeline.py` 不用改。
- `pyworld` / `torchcrepe` 只有 harvest / crepe 音高法會用到；我用 `rmvpe`，所以這兩個模組用假的頂上，
  不裝（省 100 MB 以上的編譯）。
- `rmvpe.pt`（181 MB）放在 venv 的 `site-packages/rvc_python/base_model/`，
  `hubert_base.pt` 留 0 位元組佔位（真的不會被讀）。

## 實測

| 項目 | 結果 |
| --- | --- |
| 第一次跑（含下載 ContentVec） | 93 秒 |
| 工人模式：載入模型 | 0.3 秒（之後常駐） |
| 工人模式：第一句（rmvpe 首次載入） | 12.8 秒 |
| 工人模式：之後每句 3–4 秒音檔 | 2.6–4.1 秒 |
| 時長對齊 | 3.90s → 3.88s、4.29s → 4.28s、3.01s → 3.00s |
| 輸出格式 | 40 kHz、16-bit |

## 接了什麼

- `scripts/rvc/worker.py`：常駐工人，stdin/stdout 一行一個 JSON
  （`{"id","in","out","f0up","index"}` → `{"id","ok","ms"}`），模型只載一次；
  庫的進度條/警告全部丟到 stderr，不會弄壞協議。
- `src/rvc-voice.js`：Node 端包裝。第一次用到才起工人、請求排隊、超時回 `timeout`、
  工人死掉回 `worker-not-started` 並記一行 log——**語音壞了不影響已送出的文字**。
- `src/discord-lane.js`：`maybeSendVoice()` 在 SAPI 出檔後，若 `voice.rvc.enabled` 為真就再換聲，
  失敗自動退回原聲（log `換聲沒成功（…），這句用原聲`）。
- 設定（`config.json` / `config.example.json` 的 `discord.lane.voice`）：
  `{ enabled, chance, maxChars, rate, rvc: { enabled:false, python:"state/voice-venv/Scripts/python.exe", worker:"scripts/rvc/worker.py", modelDir:"state/voice-model", indexRate:0.75, f0up:0, timeoutMs:120000 } }`。

## 為什麼 `rvc.enabled` 預設是 false

換聲跟「她像不像」是兩件事：時長、取樣率、音量都對，但**音色像不像只有人耳能判斷**。
所以先把樣本丟到 Discord 讓使用者聽（訊息 `（換聲測試）原文：…`），確認像再開。
大不了把 `enabled` 改回 false，文字與 SAPI 語音都不受影響。

## 遺留

- 音色驗收（人耳）；若「電子味」重，可調 `index_rate` 0.75→0.5、`protect`、或特徵層 12→9。
- CPU 上每句 3–4 秒；要更快得導出 ONNX 或換 GPU（這台沒有）。
- 模型與 venv 都在 `state/`（被 `.gitignore` 蓋住，約 1.4 GB），不進 repo。
- 只有 `rmvpe` 一條音高路；若哪天要 harvest，得裝 `pyworld`。
