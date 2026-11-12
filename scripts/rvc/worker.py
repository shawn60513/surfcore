"""Long-lived RVC worker for the lane.

Standard input: one JSON object per line
    {"id": 1, "in": "C:/.../in.wav", "out": "C:/.../out.wav", "f0up": 0, "index": 0.75}

Standard output: one JSON object per line
    {"ready": true}                     -- once, after the model is loaded
    {"id": 1, "ok": true, "ms": 2800}   -- per request
    {"id": 1, "ok": false, "error": "..."}

Everything the libraries print (progress bars, warnings) goes to stderr so it
never corrupts the protocol on stdout.
"""

import contextlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

_real_stdout = sys.stdout


@contextlib.contextmanager
def _stdout_to_stderr():
    with contextlib.redirect_stdout(sys.stderr):
        yield


import infer_aimisi as ia  # noqa: E402  applies the fairseq/contentvec patches

import numpy as np  # noqa: E402
from scipy.io import wavfile  # noqa: E402
from rvc_python.infer import RVCInference  # noqa: E402


def load_model():
    model_dir = os.environ.get("RVC_MODEL_DIR", os.path.abspath(os.path.join(HERE, "..", "voice-model")))
    pth = [f for f in os.listdir(model_dir) if f.endswith(".pth")][0]
    index = [f for f in os.listdir(model_dir) if f.endswith(".index")]
    rvc = RVCInference(models_dir=os.path.join(HERE, "models"), device="cpu:0")
    rvc.set_params(f0method="rmvpe", f0up_key=0, index_rate=0.75, protect=0.33,
                   rms_mix_rate=1.0, filter_radius=3, resample_sr=0)
    rvc.load_model(os.path.join(model_dir, pth), version="v2",
                   index_path=os.path.join(model_dir, index[0]) if index else "")
    return rvc


def convert(rvc, req):
    """Run one conversion.

    rvc_python's infer_file() does `wavfile.write(..., wav_opt)` without checking
    for the failure shape: on any internal error vc_single() returns
    `(traceback_text, (None, None))`, and the real cause is hidden behind
    "'tuple' object has no attribute 'dtype'". So we call vc_single() ourselves
    and surface that message instead of guessing.
    """
    res = rvc.vc.vc_single(
        sid=0,
        input_audio_path=req["in"],
        f0_up_key=int(req.get("f0up", 0)),
        f0_method=rvc.f0method,
        file_index=rvc.models[rvc.current_model].get("index", ""),
        index_rate=float(req.get("index", 0.75)),
        filter_radius=int(req.get("filter", 3)),
        resample_sr=int(req.get("resample", rvc.resample_sr)),
        rms_mix_rate=float(req.get("rms", 1.0)),
        protect=float(req.get("protect", 0.33)),
        f0_file="",
        file_index2="",
    )
    if isinstance(res, tuple):  # (error text, (None, None))
        raise RuntimeError(str(res[0]).strip().splitlines()[-1] if res else "vc_single failed")

    audio = res
    sr = int(rvc.vc.tgt_sr)
    if audio.dtype != np.int16:
        audio = np.clip(audio, -1.0, 1.0)
        audio = (audio * 32767.0).astype(np.int16)
    wavfile.write(req["out"], sr, audio)


def main():
    with _stdout_to_stderr():
        rvc = load_model()
    _real_stdout.write(json.dumps({"ready": True}) + "\n")
    _real_stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # malformed line: report and keep going
            _real_stdout.write(json.dumps({"ok": False, "error": "bad json: %s" % exc}) + "\n")
            _real_stdout.flush()
            continue

        rid = req.get("id")
        t0 = time.time()
        try:
            with _stdout_to_stderr():
                convert(rvc, req)
            out = {"id": rid, "ok": True, "ms": int((time.time() - t0) * 1000)}
        except Exception as exc:  # keep the worker alive even if one file fails
            import traceback

            tb = traceback.format_exc().strip().splitlines()[-3:]
            out = {
                "id": rid,
                "ok": False,
                "error": "%s: %s" % (type(exc).__name__, exc),
                "where": " | ".join(line.strip() for line in tb),
            }
        _real_stdout.write(json.dumps(out) + "\n")
        _real_stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
