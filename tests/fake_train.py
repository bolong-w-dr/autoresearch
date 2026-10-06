"""
Stand-in for train.py used by the service tests.

Reads the hyperparameter constants from ./train.py (text only, no torch) and
prints a deterministic summary in the same format as the real script, so the
runner's parsing and keep/discard logic can be exercised without a GPU.
"""

import re
import sys
import time
from pathlib import Path


def read_constants(path: Path) -> dict:
    consts = {}
    for line in path.read_text().splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)(\s*#.*)?$", line)
        if m:
            try:
                consts[m.group(1)] = eval(m.group(2), {"__builtins__": {}})  # noqa: S307 - test fixture
            except Exception:
                consts[m.group(1)] = m.group(2)
    return consts


def main() -> int:
    consts = read_constants(Path("train.py"))
    depth = int(consts.get("DEPTH", 8))
    lr = float(consts.get("MATRIX_LR", 0.04))
    if depth >= 99:
        print("Traceback (most recent call last):")
        print("torch.OutOfMemoryError: CUDA out of memory")
        return 1
    if consts.get("WINDOW_PATTERN") == "HANG":
        time.sleep(3600)
    # Lower is better; a higher LR up to 0.05 helps, deeper helps a bit.
    val_bpb = 1.0 - min(lr, 0.05) * 2 - depth * 0.001
    print("step 00001 (0.0%) | loss: 4.0 | ...")
    print("---")
    print(f"val_bpb:          {val_bpb:.6f}")
    print("training_seconds: 300.0")
    print("total_seconds:    320.0")
    print(f"peak_vram_mb:     {depth * 5000:.1f}")
    print("mfu_percent:      39.80")
    print("total_tokens_M:   499.6")
    print("num_steps:        953")
    print("num_params_M:     50.3")
    print(f"depth:            {depth}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
