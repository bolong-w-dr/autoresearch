import subprocess
import sys
from pathlib import Path

import pytest

from autoresearch_service.records import MissionRecord
from autoresearch_service.runner import MissionControl, MissionRunner, RunnerConfig, apply_overrides, parse_metrics
from autoresearch_service.schema import Mission

REPO_TRAIN = (Path(__file__).resolve().parent.parent / "train.py").read_text()


def test_parse_metrics_reads_summary_block():
    log = "step 1 | loss 4.0\n---\nval_bpb:          0.997900\npeak_vram_mb:     45060.2\nnum_steps:        953\n"
    assert parse_metrics(log) == {"val_bpb": 0.9979, "peak_vram_mb": 45060.2, "num_steps": 953.0}
    assert parse_metrics("Traceback ...\nRuntimeError: boom") == {}


def test_apply_overrides_rewrites_constants_and_keeps_comments():
    out = apply_overrides(REPO_TRAIN, {"MATRIX_LR": 0.05, "WINDOW_PATTERN": "L", "ADAM_BETAS": [0.9, 0.95], "DEPTH": 10})
    assert "MATRIX_LR = 0.05        # learning rate for matrix parameters (Muon)" in out
    assert "WINDOW_PATTERN = 'L' # sliding window pattern" in out
    assert "ADAM_BETAS = (0.9, 0.95) # Adam beta1, beta2" in out
    assert "\nDEPTH = 10               # number of transformer layers" in out
    # Nothing else changed.
    assert out.count("\n") == REPO_TRAIN.count("\n")


def test_apply_overrides_missing_constant():
    with pytest.raises(ValueError):
        apply_overrides(REPO_TRAIN, {"NOT_A_CONSTANT": 1})


def _run(repo: Path, train_command, mission: Mission) -> MissionRecord:
    record = MissionRecord(mission=mission)
    config = RunnerConfig(repo_dir=repo, worktrees_dir=repo / "worktrees", train_command=train_command)
    updates = []
    runner = MissionRunner(config, record, MissionControl(), on_update=lambda r: updates.append(r.state))
    runner.run()
    assert updates, "runner must publish progress"
    return record


def test_sweep_mission_keeps_and_discards(repo, train_command):
    mission = Mission(
        name="sweep",
        tag="t-sweep",
        strategy={
            "type": "sweep",
            "experiments": [
                {"description": "lr up", "overrides": {"MATRIX_LR": 0.05}},  # improves -> keep
                {"description": "lr down", "overrides": {"MATRIX_LR": 0.01}},  # worse -> discard
                {"description": "oom", "overrides": {"DEPTH": 99}},  # crash
                {"description": "deeper", "overrides": {"DEPTH": 12}},  # improves -> keep
            ],
        },
        budget={"max_experiments": 10, "experiment_timeout_minutes": 1},
    )
    record = _run(repo, train_command, mission)
    assert record.state == "completed", record.error
    statuses = [e.status for e in record.experiments]
    assert statuses == ["keep", "keep", "discard", "crash", "keep"]
    assert record.baseline_val_bpb == pytest.approx(1.0 - 0.08 - 0.008)
    assert record.best.experiment_index == 4
    assert record.best.val_bpb < record.baseline_val_bpb
    assert record.experiments[3].reason.startswith("training crashed")
    assert "OutOfMemoryError" in record.experiments[3].log_tail

    worktree = Path(record.worktree)
    # Kept changes are on the branch; discarded/crashed ones were reset away.
    log = subprocess.run(["git", "log", "--format=%s", "autoresearch/t-sweep"], cwd=repo, capture_output=True, text=True).stdout
    assert log.splitlines() == ["experiment 4: deeper", "experiment 1: lr up", "init"]
    train_src = (worktree / "train.py").read_text()
    assert "MATRIX_LR = 0.05" in train_src and "DEPTH = 12" in train_src
    tsv = (worktree / "results.tsv").read_text().splitlines()
    assert tsv[0] == "commit\tval_bpb\tmemory_gb\tstatus\tdescription"
    assert len(tsv) == 6 and tsv[4].split("\t")[3] == "crash"


def test_mission_respects_max_experiments(repo, train_command):
    mission = Mission(
        name="budget", tag="t-budget",
        strategy={"type": "sweep", "experiments": [{"description": f"e{i}", "overrides": {"MATRIX_LR": 0.04 + i / 1000}} for i in range(5)]},
        budget={"max_experiments": 2, "experiment_timeout_minutes": 1},
    )
    record = _run(repo, train_command, mission)
    assert record.state == "completed"
    assert len(record.experiments) == 2
    assert any("max_experiments" in e.message for e in record.events)


def test_timeout_is_recorded_as_crash(repo, train_command):
    mission = Mission(
        name="hang", tag="t-hang",
        strategy={"type": "sweep", "experiments": [{"description": "hang", "overrides": {"WINDOW_PATTERN": "HANG"}}]},
        budget={"max_experiments": 2, "experiment_timeout_minutes": 1},
    )
    # Shorten the timeout for the test by monkeypatching the budget after validation.
    mission.budget.experiment_timeout_minutes = 1
    record = MissionRecord(mission=mission)
    config = RunnerConfig(repo_dir=repo, worktrees_dir=repo / "worktrees", train_command=train_command)
    runner = MissionRunner(config, record, MissionControl(), on_update=lambda r: None)
    runner.mission.budget.experiment_timeout_minutes = 0.02  # ~1 second
    runner.run()
    assert record.state == "completed"
    assert record.experiments[1].status == "crash"
    assert "timeout" in record.experiments[1].reason


def test_existing_branch_fails_fast(repo, train_command):
    subprocess.run(["git", "branch", "autoresearch/dup"], cwd=repo, check=True)
    mission = Mission(name="dup", tag="dup", strategy={"type": "sweep", "experiments": [{"description": "x"}]})
    record = _run(repo, train_command, mission)
    assert record.state == "failed"
    assert "already exists" in record.error


def test_agent_strategy_invokes_command(repo, train_command, tmp_path):
    agent = tmp_path / "agent.py"
    agent.write_text(
        "import sys, re, pathlib\n"
        "prompt = pathlib.Path(sys.argv[1]).read_text()\n"
        "assert 'Mission: agent' in prompt and 'program.md' in prompt.lower()\n"
        "p = pathlib.Path('train.py'); s = p.read_text()\n"
        "p.write_text(re.sub(r'^MATRIX_LR = .*$', 'MATRIX_LR = 0.05', s, flags=re.M))\n"
        "pathlib.Path(sys.argv[2]).write_text('agent: bump matrix lr\\n')\n"
    )
    mission = Mission(
        name="agent", tag="t-agent",
        strategy={"type": "agent", "command": [sys.executable, str(agent), "{prompt_file}", "{description_file}"], "timeout_minutes": 1},
        budget={"max_experiments": 3, "experiment_timeout_minutes": 1},
    )
    record = _run(repo, train_command, mission)
    assert record.state == "completed", record.error
    assert [e.status for e in record.experiments] == ["keep", "keep", "skipped"]
    assert record.experiments[1].description == "agent: bump matrix lr"
    assert record.experiments[2].reason == "no change to train.py"
