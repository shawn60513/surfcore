"""RVC v2 inference for the Aemeath voice pack, without fairseq.

The official RVC pipeline gets content features from a fairseq HuBERT checkpoint
(`base_model/hubert_base.pt`). fairseq does not build on this machine's Python
(3.12), so we feed the same features from the HF port of ContentVec
(`lengyue233/content-vec-best`) and stub out the fairseq import.

Usage:
    python infer_aimisi.py <input.wav> <output.wav> [f0up_key] [index_rate]
"""

import os
import sys
import types

import numpy as np
import torch

SRC = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SRC)

# --- fairseq stub: rvc_python/modules/vc/utils.py imports fairseq only to load
#     hubert; we replace load_hubert() right after import. ---------------------
_fake = types.ModuleType("fairseq")
_fake.checkpoint_utils = types.SimpleNamespace(load_model_ensemble_and_task=None)
sys.modules.setdefault("fairseq", _fake)
sys.modules.setdefault("fairseq.checkpoint_utils", _fake.checkpoint_utils)

# --- optional deps only needed by the harvest/crepe f0 methods we don't use ---
for _name in ("pyworld", "torchcrepe"):
    try:
        __import__(_name)
    except Exception:
        _m = types.ModuleType(_name)

        def _boom(*_a, **_k):
            raise RuntimeError(_name + " is not installed (only needed for harvest/crepe f0)")

        _m.harvest = _boom
        _m.stonemask = _boom
        _m.predict = _boom
        _m.filter = types.SimpleNamespace(median=_boom, mean=_boom)
        sys.modules[_name] = _m

from rvc_python.infer import RVCInference  # noqa: E402
import rvc_python.modules.vc.modules as vc_modules  # noqa: E402
import rvc_python.modules.vc.utils as vc_utils  # noqa: E402

CONTENT_MODEL = os.environ.get("RVC_CONTENT_MODEL", "lengyue233/content-vec-best")


class HubertContentVec(torch.nn.Module):
    """Drop-in for fairseq HuBERT: extract_features(source, padding_mask, output_layer)."""

    def __init__(self, device="cpu"):
        super().__init__()
        from transformers import HubertModel

        self.model = HubertModel.from_pretrained(CONTENT_MODEL)
        self.model.to(device).eval()

    @torch.no_grad()
    def extract_features(self, source=None, padding_mask=None, output_layer=12, **kwargs):
        out = self.model(source, output_hidden_states=True)
        hidden = out.hidden_states
        layer = max(0, min(int(output_layer), len(hidden) - 1))
        return (hidden[layer],)

    def final_proj(self, feats):
        return feats


def load_hubert_contentvec(config, lib_dir):
    return HubertContentVec(device=config.device)


vc_utils.load_hubert = load_hubert_contentvec
vc_modules.load_hubert = load_hubert_contentvec


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    in_path, out_path = argv[1], argv[2]
    f0up_key = int(argv[3]) if len(argv) > 3 else 0
    index_rate = float(argv[4]) if len(argv) > 4 else 0.75

    model_dir = os.environ.get(
        "RVC_MODEL_DIR", os.path.abspath(os.path.join(SRC, "..", "voice-model"))
    )
    pth = [f for f in os.listdir(model_dir) if f.endswith(".pth")][0]
    index = [f for f in os.listdir(model_dir) if f.endswith(".index")]

    rvc = RVCInference(models_dir=os.path.join(SRC, "models"), device="cpu:0")
    rvc.set_params(
        f0method="rmvpe",
        f0up_key=f0up_key,
        index_rate=index_rate,
        protect=0.33,
        rms_mix_rate=1.0,
        filter_radius=3,
        resample_sr=0,
    )
    rvc.load_model(
        os.path.join(model_dir, pth),
        version="v2",
        index_path=os.path.join(model_dir, index[0]) if index else "",
    )
    rvc.infer_file(in_path, out_path)
    print("written", out_path, os.path.getsize(out_path), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
