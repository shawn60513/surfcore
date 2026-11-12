"""GPT-SoVITS v4 常駐合成工人。

一行一個請求（stdin），一行一個回應（stdout）：
    {"id": 1, "text": "在嘛。", "out": "C:/.../x.wav", "speed": 1.0}
    -> {"id": 1, "ok": true, "ms": 4400, "dur": 3.8, "sr": 32000}

模型只在啟動時載入一次；任何一條失敗都不退出。
真正的 stdout 只留協議；庫的雜訊全部導去 stderr。
"""

import contextlib
import json
import os
import sys
import time
import traceback
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GSV_HOME = os.path.join(ROOT, "state", "gsv")
GS = os.path.join(GSV_HOME, "gs")


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv):
    cfg_path = argv[1] if len(argv) > 1 else os.path.join(GSV_HOME, "tts_config.yaml")
    pack_dir = argv[2] if len(argv) > 2 else os.path.join(GSV_HOME, "pack")
    ref_audio = os.path.join(pack_dir, "ref", "aemeath_ref.wav")
    prompt_file = os.path.join(pack_dir, "ref", "prompt.txt")
    lang = argv[3] if len(argv) > 3 else "zh"

    os.environ.setdefault("MPLCONFIGDIR", os.path.join(GSV_HOME, "tmp", "mpl"))
    os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(GSV_HOME, "tmp", "numba"))
    os.makedirs(os.environ["MPLCONFIGDIR"], exist_ok=True)
    os.makedirs(os.environ["NUMBA_CACHE_DIR"], exist_ok=True)
    os.chdir(GS)
    sys.path.insert(0, "GPT_SoVITS")
    sys.path.insert(0, ".")

    import numpy as np

    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    prompt_text = ""
    if os.path.exists(prompt_file):
        with open(prompt_file, "r", encoding="utf-8") as f:
            prompt_text = f.read().strip()

    with contextlib.redirect_stdout(sys.stderr):
        cfg = TTS_Config(cfg_path)
        tts = TTS(cfg)

    reply({"ready": True, "device": str(cfg.device), "version": str(cfg.version), "ref": ref_audio})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg_id = None
        try:
            req = json.loads(line)
            msg_id = req.get("id")
            if req.get("cmd") == "stop":
                reply({"id": msg_id, "ok": True})
                return 0

            text = str(req.get("text") or "").strip()
            out = str(req.get("out") or "").strip()
            speed = float(req.get("speed") or 1.0)
            if not text or not out:
                raise ValueError("text 與 out 都要有")

            t0 = time.time()
            run_req = {
                "text": text,
                "text_lang": str(req.get("lang") or lang),
                "ref_audio_path": ref_audio,
                "prompt_text": prompt_text,
                "prompt_lang": str(req.get("promptLang") or lang),
                "top_k": int(req.get("topK") or 15),
                "top_p": float(req.get("topP") or 1.0),
                "temperature": float(req.get("temperature") or 1.0),
                "text_split_method": str(req.get("split") or "cut5"),
                "batch_size": 1,
                "speed_factor": speed,
                "streaming_mode": False,
                "return_fragments": False,
                "seed": int(req.get("seed") or 42),
            }

            chunks = []
            sr = None
            with contextlib.redirect_stdout(sys.stderr):
                for item in tts.run(run_req):
                    if isinstance(item, dict):
                        sr = int(item.get("sample_rate") or sr or 32000)
                        audio = item.get("audio")
                        if isinstance(audio, (tuple, list)) and len(audio) > 1:
                            audio = audio[1]
                    else:
                        sr, audio = item
                        sr = int(sr)
                    chunks.append(np.asarray(audio))

            if not chunks:
                raise RuntimeError("沒有合成出音訊")
            audio = np.concatenate(chunks).astype(np.int16)

            os.makedirs(os.path.dirname(out), exist_ok=True)
            with wave.open(out, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sr)
                w.writeframes(audio.tobytes())

            dur = len(audio) / float(sr)
            reply({"id": msg_id, "ok": True, "ms": int((time.time() - t0) * 1000), "dur": round(dur, 2), "sr": sr, "out": out})
        except Exception as exc:  # noqa: BLE001
            tail = traceback.format_exc().strip().splitlines()[-3:]
            reply({"id": msg_id, "ok": False, "error": f"{type(exc).__name__}: {exc}", "where": " | ".join(tail)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
