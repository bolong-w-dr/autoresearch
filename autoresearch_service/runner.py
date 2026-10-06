"""
Mission runner: executes the autoresearch experiment loop for one mission.

The loop mirrors ``program.md``: establish a baseline, then repeatedly propose
a change (from a sweep list or an external agent), commit it, run ``train.py``
for the fixed time budget, and keep or discard the commit depending on
``val_bpb``. All work happens in a dedicated git worktree on branch
``autoresearch/<tag>`` so the main checkout is never disturbed.
"""

from __future__ import annotations

import os
import re
import shlex
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from .records import BestResult, ExperimentRecord, MissionRecord
from .schema import AgentStrategy, Mission, SweepExperiment, SweepStrategy, utcnow

METRIC_LINE = re.compile(r"^([a-z_]+):\s+(-?[0-9.]+)\s*$")
TRAIN_FILE = "train.py"
LOG_TAIL_LINES = 60


class MissionAborted(Exception):
    """Raised inside the loop when the mission is cancelled."""


@dataclass
class MissionControl:
    """Thread-safe flags the service flips in response to queue commands."""

    pause: threading.Event = field(default_factory=threading.Event)
    stop: threading.Event = field(default_factory=threading.Event)
    cancel: threading.Event = field(default_factory=threading.Event)
    _proc_lock: threading.Lock = field(default_factory=threading.Lock)
    _proc: Optional[subprocess.Popen] = None

    def attach(self, proc: Optional[subprocess.Popen]) -> None:
        with self._proc_lock:
            self._proc = proc

    def kill_running(self) -> None:
        with self._proc_lock:
            proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()


@dataclass
class RunnerConfig:
    repo_dir: Path
    worktrees_dir: Path
    train_command: Sequence[str]  # executed with cwd=worktree
    program_md: Optional[Path] = None
    git_user: str = "autoresearch-service"
    git_email: str = "autoresearch-service@localhost"


def run_git(args: Sequence[str], cwd: Path, check: bool = True) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def parse_metrics(log_text: str) -> Dict[str, float]:
    """Extract the ``key: value`` summary printed after ``---`` by train.py."""
    metrics: Dict[str, float] = {}
    in_summary = False
    for line in log_text.splitlines():
        if line.strip() == "---":
            in_summary = True
            metrics = {}
            continue
        if not in_summary:
            continue
        m = METRIC_LINE.match(line.strip())
        if m:
            try:
                metrics[m.group(1)] = float(m.group(2))
            except ValueError:
                pass
    return metrics


def format_override(value: Any) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "(" + ", ".join(format_override(v) for v in value) + ")"
    raise TypeError(f"unsupported override value: {value!r}")


def apply_overrides(source: str, overrides: Dict[str, Any]) -> str:
    """Rewrite top-level ``NAME = value`` constant assignments in train.py."""
    lines = source.splitlines(keepends=True)
    seen: set[str] = set()
    for i, line in enumerate(lines):
        m = re.match(r"^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)(\s*#.*)?\n?$", line)
        if not m or m.group(1) not in overrides:
            continue
        name = m.group(1)
        comment = m.group(3) or ""
        newline = "\n" if line.endswith("\n") else ""
        lines[i] = f"{name} = {format_override(overrides[name])}{comment}{newline}"
        seen.add(name)
    missing = sorted(set(overrides) - seen)
    if missing:
        raise ValueError(f"constants not found in {TRAIN_FILE}: {missing}")
    return "".join(lines)


class MissionRunner:
    def __init__(
        self,
        config: RunnerConfig,
        record: MissionRecord,
        control: MissionControl,
        on_update: Callable[[MissionRecord], None],
    ):
        self.config = config
        self.record = record
        self.mission: Mission = record.mission
        self.control = control
        self.on_update = on_update
        self.worktree = config.worktrees_dir / self.mission.tag
        self.branch = f"autoresearch/{self.mission.tag}"
        self._started = time.monotonic()

    # -- public ------------------------------------------------------------

    def run(self) -> None:
        record = self.record
        try:
            self._setup()
            self._loop()
            if record.state == "stopping":
                record.state = "stopped"
                record.log("Mission stopped by operator.")
            elif record.state == "running":
                record.state = "completed"
                record.log("Mission completed: budget exhausted or strategy finished.")
        except MissionAborted:
            record.state = "cancelled"
            record.log("Mission cancelled by operator.", level="warning")
        except Exception as exc:  # noqa: BLE001 - we want the mission to record any failure
            record.state = "failed"
            record.error = f"{type(exc).__name__}: {exc}"
            record.log(record.error, level="error")
        finally:
            record.finished_at = utcnow()
            self._update()

    # -- setup -------------------------------------------------------------

    def _setup(self) -> None:
        record = self.record
        repo = self.config.repo_dir
        record.state = "running"
        record.started_at = utcnow()
        record.branch = self.branch
        record.worktree = str(self.worktree)

        existing = run_git(["branch", "--list", self.branch], cwd=repo)
        if existing:
            raise RuntimeError(f"branch {self.branch} already exists; choose a fresh tag")
        if self.worktree.exists():
            raise RuntimeError(f"worktree path {self.worktree} already exists")

        base_commit = run_git(["rev-parse", "--verify", f"{self.mission.base_ref}^{{commit}}"], cwd=repo)
        record.base_commit = base_commit
        self.worktree.parent.mkdir(parents=True, exist_ok=True)
        run_git(["worktree", "add", "-b", self.branch, str(self.worktree), base_commit], cwd=repo)
        record.head_commit = base_commit
        record.log(f"Created worktree {self.worktree} on {self.branch} from {self.mission.base_ref} ({base_commit[:7]}).")
        (self.worktree / "results.tsv").write_text("commit\tval_bpb\tmemory_gb\tstatus\tdescription\n")
        self._update()

    # -- main loop ---------------------------------------------------------

    def _loop(self) -> None:
        strategy = self.mission.strategy
        budget = self.mission.budget

        # Experiment 0 is always the untouched baseline.
        self._run_experiment(description="baseline", prepare=None)

        planned = iter(strategy.experiments) if isinstance(strategy, SweepStrategy) else None
        while True:
            self._wait_if_paused()
            if self.record.state == "stopping" or self.control.stop.is_set():
                self.record.state = "stopping"
                return
            if len(self.record.experiments) >= budget.max_experiments:
                self.record.log(f"Reached max_experiments={budget.max_experiments}.")
                return
            if budget.max_duration_minutes and (time.monotonic() - self._started) > budget.max_duration_minutes * 60:
                self.record.log(f"Reached max_duration_minutes={budget.max_duration_minutes}.")
                return

            if planned is not None:
                planned_exp = next(planned, None)
                if planned_exp is None:
                    self.record.log("Sweep finished: all planned experiments ran.")
                    return
                self._run_experiment(
                    description=planned_exp.description,
                    prepare=lambda exp=planned_exp: self._prepare_sweep(exp),
                    overrides=dict(planned_exp.overrides),
                )
            else:
                assert isinstance(strategy, AgentStrategy)
                self._run_experiment(description="agent proposal", prepare=self._prepare_agent)

    def _wait_if_paused(self) -> None:
        if not self.control.pause.is_set():
            return
        if self.record.state == "running":
            self.record.state = "paused"
            self.record.log("Mission paused.")
            self._update()
        while self.control.pause.is_set():
            self._check_cancel()
            if self.control.stop.is_set():
                self.record.state = "stopping"
                return
            time.sleep(0.5)
        if self.record.state == "paused":
            self.record.state = "running"
            self.record.log("Mission resumed.")
            self._update()

    def _check_cancel(self) -> None:
        if self.control.cancel.is_set():
            raise MissionAborted()

    # -- experiment preparation -------------------------------------------

    def _prepare_sweep(self, exp: SweepExperiment) -> str:
        path = self.worktree / TRAIN_FILE
        path.write_text(apply_overrides(path.read_text(), exp.overrides))
        return exp.description

    def _prepare_agent(self) -> str:
        strategy = self.mission.strategy
        assert isinstance(strategy, AgentStrategy)
        prompt_file = self.worktree / ".autoresearch" / "prompt.md"
        description_file = self.worktree / ".autoresearch" / "description.txt"
        prompt_file.parent.mkdir(exist_ok=True)
        if description_file.exists():
            description_file.unlink()
        prompt_file.write_text(self._build_agent_prompt(description_file))
        placeholders = {
            "prompt_file": str(prompt_file),
            "description_file": str(description_file),
            "worktree": str(self.worktree),
        }
        command = [part.format(**placeholders) for part in strategy.command]
        self.record.log(f"Invoking agent: {shlex.join(command)}")
        self._update()
        proc = subprocess.Popen(
            command, cwd=self.worktree, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, start_new_session=True
        )
        self.control.attach(proc)
        try:
            _, stderr = proc.communicate(timeout=strategy.timeout_minutes * 60)
        except subprocess.TimeoutExpired:
            self.control.kill_running()
            raise RuntimeError(f"agent exceeded timeout of {strategy.timeout_minutes} minutes")
        finally:
            self.control.attach(None)
        self._check_cancel()
        if proc.returncode != 0:
            raise RuntimeError(f"agent exited with code {proc.returncode}: {(stderr or '').strip()[-500:]}")
        if description_file.exists():
            description = description_file.read_text().strip().splitlines()
            description_file.unlink()
            return (description[0] if description else "agent proposal")[:200]
        return f"agent proposal #{len(self.record.experiments)}"

    def _build_agent_prompt(self, description_file: Path) -> str:
        strategy = self.mission.strategy
        assert isinstance(strategy, AgentStrategy)
        program = ""
        program_path = self.config.program_md or (self.config.repo_dir / "program.md")
        if program_path.exists():
            program = program_path.read_text()
        results = "\n".join(
            f"{e.index}\t{e.commit or '-'}\t{e.val_bpb if e.val_bpb is not None else 0.0:.6f}\t{e.status}\t{e.description}"
            for e in self.record.experiments
        )
        best = self.record.best.val_bpb if self.record.best else None
        return (
            f"# Mission: {self.mission.name}\n\n"
            f"Objective: {self.mission.objective}\n\n"
            "You are ONE iteration of the autoresearch loop and are being driven by a harness. "
            f"Edit `{TRAIN_FILE}` in the current directory with a single experimental idea. Do NOT run training, "
            "do NOT commit, and do NOT touch any other file. When done, write a one-line description of the change to "
            f"`{description_file}` and exit.\n\n"
            f"Current best val_bpb: {best if best is not None else 'n/a'}\n\n"
            "## Results so far (index, commit, val_bpb, status, description)\n\n"
            f"{results or '(none)'}\n\n"
            + (f"## Additional instructions\n\n{strategy.instructions}\n\n" if strategy.instructions else "")
            + "## Reference: program.md\n\n"
            + program
        )

    # -- running one experiment -------------------------------------------

    def _run_experiment(self, description: str, prepare: Optional[Callable[[], str]], overrides: Optional[Dict[str, Any]] = None) -> None:
        self._check_cancel()
        record = self.record
        exp = ExperimentRecord(index=len(record.experiments), description=description, overrides=overrides or {})
        record.experiments.append(exp)
        record.log(f"Experiment {exp.index}: {description}")
        self._update()

        start_commit = run_git(["rev-parse", "HEAD"], cwd=self.worktree)
        try:
            if prepare is not None:
                exp.description = prepare() or description
                self._check_cancel()
                if not run_git(["status", "--porcelain", "--", TRAIN_FILE], cwd=self.worktree):
                    self._finish(exp, "skipped", reason=f"no change to {TRAIN_FILE}")
                    return
                exp.diff_stat = run_git(["diff", "--stat", "--", TRAIN_FILE], cwd=self.worktree)
                run_git(["add", TRAIN_FILE], cwd=self.worktree)
                self._commit(f"experiment {exp.index}: {exp.description}")
            exp.commit = run_git(["rev-parse", "--short=7", "HEAD"], cwd=self.worktree)
            self._update()

            metrics, log_tail, timed_out = self._train()
            exp.metrics = metrics
            exp.log_tail = log_tail
            self._check_cancel()

            if "val_bpb" not in metrics:
                reason = "training exceeded experiment_timeout" if timed_out else "training crashed (no val_bpb in log)"
                self._finish(exp, "crash", reason=reason)
                self._revert(start_commit, exp)
                return

            exp.val_bpb = metrics["val_bpb"]
            exp.memory_gb = round(metrics.get("peak_vram_mb", 0.0) / 1024, 1) if "peak_vram_mb" in metrics else None
            keep, reason = self._should_keep(exp)
            if keep:
                self._finish(exp, "keep", reason=reason)
                record.head_commit = run_git(["rev-parse", "HEAD"], cwd=self.worktree)
                record.best = BestResult(
                    experiment_index=exp.index, commit=exp.commit, val_bpb=exp.val_bpb, memory_gb=exp.memory_gb, description=exp.description
                )
                if exp.index == 0:
                    record.baseline_val_bpb = exp.val_bpb
            else:
                self._finish(exp, "discard", reason=reason)
                self._revert(start_commit, exp)
        except MissionAborted:
            self._finish(exp, "cancelled", reason="mission cancelled")
            self._revert(start_commit, exp)
            raise
        except Exception as exc:  # noqa: BLE001
            self._finish(exp, "crash", reason=f"{type(exc).__name__}: {exc}")
            self._revert(start_commit, exp)
            if exp.index == 0:
                raise  # a failing baseline means the setup is broken
            record.log(f"Experiment {exp.index} errored: {exc}", level="warning")

    def _should_keep(self, exp: ExperimentRecord) -> tuple[bool, str]:
        policy = self.mission.keep_policy
        assert exp.val_bpb is not None
        if policy.max_memory_gb is not None and exp.memory_gb is not None and exp.memory_gb > policy.max_memory_gb:
            return False, f"peak memory {exp.memory_gb} GB exceeds {policy.max_memory_gb} GB"
        best = self.record.best
        if best is None:
            return True, "baseline"
        if policy.direction == "min":
            delta = best.val_bpb - exp.val_bpb
        else:
            delta = exp.val_bpb - best.val_bpb
        if delta > policy.min_improvement:
            return True, f"improved {policy.metric} by {delta:.6f}"
        return False, f"{policy.metric} change {delta:+.6f} did not beat min_improvement={policy.min_improvement}"

    def _train(self) -> tuple[Dict[str, float], str, bool]:
        log_path = self.worktree / "run.log"
        timeout = self.mission.budget.experiment_timeout_minutes * 60
        timed_out = False
        with open(log_path, "w") as log_file:
            proc = subprocess.Popen(
                list(self.config.train_command), cwd=self.worktree, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True
            )
            self.control.attach(proc)
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                self.control.kill_running()
                proc.wait()
            finally:
                self.control.attach(None)
        text = log_path.read_text(errors="replace")
        tail = "\n".join(text.splitlines()[-LOG_TAIL_LINES:])
        return parse_metrics(text), tail, timed_out

    def _commit(self, message: str) -> None:
        # Identity and signing are passed per-invocation so the shared repo config is never modified
        # and experiment commits do not depend on the operator's signing key being available.
        run_git(
            [
                "-c", f"user.name={self.config.git_user}",
                "-c", f"user.email={self.config.git_email}",
                "-c", "commit.gpgsign=false",
                "commit", "-q", "--no-verify", "-m", message,
            ],
            cwd=self.worktree,
        )

    def _revert(self, start_commit: str, exp: ExperimentRecord) -> None:
        if exp.index == 0:
            return
        run_git(["reset", "-q", "--hard", start_commit], cwd=self.worktree, check=False)

    def _finish(self, exp: ExperimentRecord, status: str, reason: Optional[str] = None) -> None:
        exp.status = status  # type: ignore[assignment]
        exp.reason = reason
        exp.finished_at = utcnow()
        exp.duration_seconds = round((exp.finished_at - exp.started_at).total_seconds(), 1)
        self._append_results_tsv(exp)
        self.record.log(f"Experiment {exp.index} -> {status}" + (f" ({reason})" if reason else ""))
        self._update()

    def _append_results_tsv(self, exp: ExperimentRecord) -> None:
        if exp.status in ("skipped", "cancelled"):
            return
        row = "\t".join(
            [
                exp.commit or "-------",
                f"{exp.val_bpb or 0.0:.6f}",
                f"{exp.memory_gb or 0.0:.1f}",
                exp.status,
                exp.description.replace("\t", " ").replace("\n", " "),
            ]
        )
        with open(self.worktree / "results.tsv", "a") as f:
            f.write(row + "\n")

    def _update(self) -> None:
        self.record.touch()
        self.on_update(self.record)
