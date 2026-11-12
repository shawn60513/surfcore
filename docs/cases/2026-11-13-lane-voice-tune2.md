# 2026-11-13 · 換聲第二輪調音：太快、太低、電子音

## 現象

用户聽完第一輪樣本：「聲音速度太慢了,而且有點低了,而且有電子音,你自己去比對日配的小愛慢慢調整」。
第一輪的預設是 `rate: 6`、`f0up: 6`、`indexRate: 0.5`、`rmsMixRate: 0.25`。

## 量基準：日配到底是多高

`BV1Lbcvz5ECX`（爱弥斯语音｜日配·佐藤聪美）用 `yt-dlp` 抓 p6/p3 到 `state/voice-ref/`，用 librosa `pyin`（fmin 120 / fmax 600）量：

| 音檔 | 中位 F0 | p25 | p75 |
| --- | ---: | ---: | ---: |
| `jp_ref.wav`（231.2s，p6） | **351.4 Hz** | 297.2 | 420.3 |
| `jp_p3.wav`（75.7s，p3） | 337.5 Hz | 285.4 | 389.9 |

同一句話的 SAPI 原聲（rate 4）只有 **181.9 Hz**。

## 重要更正：上一輪的 pitch 網格量錯了

上一輪用自相關法量，得到「p6 = 307.7 Hz、對日配只差 −1.5 半音」，於是設了 `f0up: 6`。
自相關法在這類高頻女聲上會挑到 2 倍週期（低八度），**307.7 Hz 那組數字不可信**。
改用 pyin 重掃（來源同一句、rate 4、`index 0.4` / `rms 0.45`）：

| f0up | 實測中位 F0 | 相對原聲 |
| ---: | ---: | ---: |
| 0 | 181.9 Hz | 0 |
| +9 | 302.4 Hz | +8.8 半音 |
| +10 | — | — |
| **+11** | **≈350 Hz** | **≈+11 半音** |
| +12 | 363.8 Hz | +12 半音 |
| +15 | 427.6 Hz | +15 半音 |

也就是說：`f0up` 與實際半音幾乎 1:1（RVC 的 `f0_up_key` 就是半音），要對齊日配得 **+11**，不是 +6。

## 這一輪改了什麼

- `discord.lane.voice.rate`: `6 → 4`（30 字在 rate 3/4/5 下分別 4.72 / 4.24 / 3.80 秒；6 對中文短句明顯趕）。
- `discord.lane.voice.rvc.f0up`: `6 → 11`（對齊日配中位 351 Hz）。
- `discord.lane.voice.rvc.indexRate`: `0.5 → 0.4`（少拿原聲，減電子味）。
- `discord.lane.voice.rvc.rmsMixRate`: `0.25 → 0.45`（音量起伏自然一點，聽起來不像壓平過的）。
- `config.json` 與 `config.example.json` 同步；`rate` 那一筆先單獨提交（`94f1aeb`）。

## 給人耳聽的樣本（DM `1567777542910386347`）

| 標籤 | 參數 | 訊息 id |
| --- | --- | --- |
| rate 3 / 4 / 5 | 語速掃描（f0up 6 舊值） | `1570558696294055987` / `1570558717907443724` / `1570558748290846834` |
| A / B | f0up 5・6，index 0.4，rms 0.45 | `1570559279348584598` / `1570559285161893941` |
| C / D | f0up 5・6，index 0.5，rms 0.45 | `1570559289540612248` / `1570559294485565491` |
| f0up 10 / 11 / 12 | index 0.4，rms 0.45，rate 4 | `1570559523217875053` / `1570559542507348039` / `1570559558382911621` |

（A/B/C/D 那三組是在發現「+6 根本不夠」之前發的，留著對照「偏低」是什麼聽感。）

## 為什麼只能調到這裡

換聲的天花板不在參數，在**來源**：SAPI 給的是標準朗讀腔的斷句與重音，RVC 只換音色，換不掉韻律。網上更接近本人的兩條路：

- [逐星雪绒「V4 Pro Max」](https://www.bilibili.com/video/BV1zgJY6VE1q)（IndexTTS-2 微調、中配）：作者片尾明說「分享範圍等許可確認後再決定」＝**還沒放出來**。
- [Mark42IRP/Aemeath_onnx_GSV_model](https://huggingface.co/Mark42IRP/Aemeath_onnx_GSV_model)（GPT-SoVITS ONNX）：官方桌寵 `aimisiV2` 用的就是它，模型 1.06–1.68 GB、執行環境 1.62 GB，**綁 Python 3.11 + CUDA**；本機是 3.12、無 GPU，要用得先裝一套 3.11。
- 我們現在這份 `AemeathJP_e250_s7250_RVCv2_RMVPE.zip` 來自 [PGR-RVC/Wuthering_Waves_RVC_v2](https://huggingface.co/PGR-RVC/Wuthering_Waves_RVC_v2)，是社群最普及的那份（63 個角色、只有日配），沒有第二個更流行的來源。

## 工具

- `state/voice-src/measure_f0.py`：`pyin` 量中位/p25/p75，別再用自相關（會低八度）。
- `scripts/rvc/worker.py` 的參數一路從 `config.json` 的 `voice.rvc` 傳進來，改設定不用改碼。

## 遺留

- 若哪天拿到 V4 Pro Max 或跑起 GSV，換掉的是「來源」這一層，`rvc-voice.js` 與 `maybeSendVoice()` 的接法可以照抄。
- `f0up 11` 是對齊日配**中位數**；如果聽起來太尖，往下 1–2 格（10 或 9）仍然在合理範圍。
