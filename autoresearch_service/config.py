"""Service configuration from environment variables (overridable via CLI flags)."""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

ENV_PREFIX = "AUTORESEARCH_"


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(ENV_PREFIX + name, default)


@dataclass
class ServiceConfig:
    repo_dir: Path = field(default_factory=lambda: Path(_env("REPO_DIR", ".")).resolve())
    queue_url: str = field(default_factory=lambda: _env("QUEUE_URL", "queue"))
    store_url: str = field(default_factory=lambda: _env("STORE_URL", "results"))
    worktrees_dir: Optional[Path] = field(default_factory=lambda: Path(p) if (p := _env("WORKTREES_DIR")) else None)
    train_command: Optional[List[str]] = field(default_factory=lambda: shlex.split(c) if (c := _env("TRAIN_COMMAND")) else None)
    poll_seconds: int = field(default_factory=lambda: int(_env("POLL_SECONDS", "10")))
    heartbeat_seconds: int = field(default_factory=lambda: int(_env("HEARTBEAT_SECONDS", "30")))
    service_id: Optional[str] = field(default_factory=lambda: _env("SERVICE_ID"))

    def resolved_worktrees_dir(self) -> Path:
        return (self.worktrees_dir or self.repo_dir / "worktrees").resolve()

    def resolved_train_command(self) -> List[str]:
        if self.train_command:
            return list(self.train_command)
        # Reuse the root project's environment so each worktree does not re-sync torch.
        return ["uv", "run", "--project", str(self.repo_dir), "python", "train.py"]
