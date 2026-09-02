#!/usr/bin/env bash
# Idempotent bootstrap for the autoresearch dev environment.
# Runs after the repository is checked out.
set -euo pipefail

# 1. Install the uv project manager if it isn't already available.
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# 2. Install pinned dependencies into .venv (torch cu128, tiktoken, rustbpe, ...).
uv sync

# 3. One-time data prep: download shards + train the BPE tokenizer into
#    ~/.cache/autoresearch. prepare.py is idempotent and skips work that is
#    already cached, so this is safe to re-run.
uv run prepare.py
