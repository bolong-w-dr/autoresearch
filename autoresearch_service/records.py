"""Persisted state for missions and experiments (what the dashboard renders)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .schema import Mission, utcnow

MissionState = Literal["queued", "running", "paused", "stopping", "completed", "stopped", "cancelled", "failed"]
ExperimentStatus = Literal["running", "keep", "discard", "crash", "skipped", "cancelled"]

TERMINAL_STATES = {"completed", "stopped", "cancelled", "failed"}


class Event(BaseModel):
    at: datetime = Field(default_factory=utcnow)
    level: Literal["info", "warning", "error"] = "info"
    message: str


class ExperimentRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    description: str
    status: ExperimentStatus = "running"
    commit: Optional[str] = None
    overrides: Dict[str, Any] = Field(default_factory=dict)
    val_bpb: Optional[float] = None
    memory_gb: Optional[float] = None
    metrics: Dict[str, float] = Field(default_factory=dict)
    started_at: datetime = Field(default_factory=utcnow)
    finished_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    diff_stat: Optional[str] = None
    log_tail: Optional[str] = None
    reason: Optional[str] = None


class BestResult(BaseModel):
    experiment_index: int
    commit: Optional[str]
    val_bpb: float
    memory_gb: Optional[float]
    description: str


class MissionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mission: Mission
    state: MissionState = "queued"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    branch: Optional[str] = None
    base_commit: Optional[str] = None
    head_commit: Optional[str] = None
    worktree: Optional[str] = None
    baseline_val_bpb: Optional[float] = None
    best: Optional[BestResult] = None
    experiments: List[ExperimentRecord] = Field(default_factory=list)
    events: List[Event] = Field(default_factory=list)
    error: Optional[str] = None
    host: Optional[str] = None

    @property
    def mission_id(self) -> str:
        return self.mission.mission_id

    def log(self, message: str, level: Literal["info", "warning", "error"] = "info") -> None:
        self.events.append(Event(level=level, message=message))
        self.touch()

    def touch(self) -> None:
        self.updated_at = utcnow()

    def summary(self) -> Dict[str, Any]:
        """Compact representation for the dashboard index."""
        counts: Dict[str, int] = {}
        for exp in self.experiments:
            counts[exp.status] = counts.get(exp.status, 0) + 1
        return {
            "mission_id": self.mission.mission_id,
            "name": self.mission.name,
            "tag": self.mission.tag,
            "state": self.state,
            "strategy": self.mission.strategy.type,
            "requested_by": self.mission.requested_by,
            "tags": self.mission.tags,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "updated_at": self.updated_at,
            "branch": self.branch,
            "num_experiments": len(self.experiments),
            "experiment_counts": counts,
            "baseline_val_bpb": self.baseline_val_bpb,
            "best_val_bpb": self.best.val_bpb if self.best else None,
            "error": self.error,
        }


class ServiceStatus(BaseModel):
    service_id: str
    host: str
    version: str
    started_at: datetime
    last_heartbeat: datetime = Field(default_factory=utcnow)
    queue: str
    store: str
    gpu: Optional[str] = None
    current_mission_id: Optional[str] = None
    queued_mission_ids: List[str] = Field(default_factory=list)
    commands_processed: int = 0
    last_command: Optional[Dict[str, Any]] = None
