import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
FAKE_TRAIN = Path(__file__).resolve().parent / "fake_train.py"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A throwaway git repo containing the real train.py and program.md on branch master."""
    root = tmp_path / "repo"
    root.mkdir()
    shutil.copy(REPO_ROOT / "train.py", root / "train.py")
    shutil.copy(REPO_ROOT / "program.md", root / "program.md")
    (root / ".gitignore").write_text("results.tsv\nrun.log\n.autoresearch/\nworktrees/\n")
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q", "-b", "master"], cwd=root, check=True)
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=root, check=True, env={**env, "PATH": "/usr/bin:/bin"})
    return root


@pytest.fixture
def train_command() -> list:
    return [sys.executable, str(FAKE_TRAIN)]
