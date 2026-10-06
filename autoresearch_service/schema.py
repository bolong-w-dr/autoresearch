"""
Mission and command schema.

A *mission* is a declarative description of an autonomous research run:
which branch to work on, how experiments are proposed (a fixed hyperparameter
sweep or an external coding agent), and when to stop. A *command* is the
envelope that arrives on the message queue and tells the service what to do.

Both are Pydantic models so the same definitions validate incoming messages
and produce the JSON Schema that the dashboard renders and validates against.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1"

# Constants in train.py that a sweep is allowed to override. Keeping this list
# explicit means a mission cannot rewrite arbitrary code through the queue.
OVERRIDABLE_HYPERPARAMETERS = (
    "ASPECT_RATIO",
    "HEAD_DIM",
    "WINDOW_PATTERN",
    "TOTAL_BATCH_SIZE",
    "EMBEDDING_LR",
    "UNEMBEDDING_LR",
    "MATRIX_LR",
    "SCALAR_LR",
    "WEIGHT_DECAY",
    "ADAM_BETAS",
    "WARMUP_RATIO",
    "WARMDOWN_RATIO",
    "FINAL_LR_FRAC",
    "DEPTH",
    "DEVICE_BATCH_SIZE",
)

OverrideValue = Union[int, float, str, bool, List[Union[int, float]]]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SweepExperiment(StrictModel):
    """One planned experiment: a description plus hyperparameter overrides."""

    description: str = Field(..., min_length=1, max_length=200, description="Short human-readable summary of the change.")
    overrides: Dict[str, OverrideValue] = Field(
        default_factory=dict,
        description="Hyperparameter constants in train.py to rewrite for this experiment, e.g. {\"MATRIX_LR\": 0.05}.",
    )

    @field_validator("overrides")
    @classmethod
    def _check_override_keys(cls, value: Dict[str, OverrideValue]) -> Dict[str, OverrideValue]:
        unknown = sorted(set(value) - set(OVERRIDABLE_HYPERPARAMETERS))
        if unknown:
            raise ValueError(f"unknown hyperparameters: {unknown}; allowed: {list(OVERRIDABLE_HYPERPARAMETERS)}")
        return value


class SweepStrategy(StrictModel):
    """Run a fixed, ordered list of experiments. Kept changes accumulate."""

    type: Literal["sweep"] = "sweep"
    experiments: List[SweepExperiment] = Field(..., min_length=1, description="Experiments to run in order after the baseline.")


class AgentStrategy(StrictModel):
    """Delegate experiment design to an external coding agent CLI.

    For each iteration the service writes a prompt file (program.md + mission
    context + results so far) and invokes ``command`` inside the mission
    worktree. The agent is expected to edit ``train.py`` and write a one-line
    description to the path given by ``{description_file}``.
    """

    type: Literal["agent"] = "agent"
    command: List[str] = Field(
        ...,
        min_length=1,
        description=(
            "Agent command line. Placeholders: {prompt_file}, {description_file}, {worktree}. "
            "Example: [\"claude\", \"-p\", \"@{prompt_file}\", \"--dangerously-skip-permissions\"]"
        ),
    )
    instructions: str = Field(
        default="",
        max_length=20000,
        description="Extra instructions appended to program.md for the agent (research directions, constraints).",
    )
    timeout_minutes: int = Field(default=20, ge=1, le=240, description="Maximum wall time for a single agent invocation.")


Strategy = Annotated[Union[SweepStrategy, AgentStrategy], Field(discriminator="type")]


class KeepPolicy(StrictModel):
    """How the service decides whether an experiment 'advances' the branch."""

    metric: Literal["val_bpb"] = Field(default="val_bpb", description="Metric to optimise. Only val_bpb is emitted by train.py today.")
    direction: Literal["min", "max"] = Field(default="min", description="Whether lower or higher is better.")
    min_improvement: float = Field(default=0.0, ge=0.0, description="Minimum absolute improvement over the current best to keep a change.")
    max_memory_gb: Optional[float] = Field(default=None, gt=0, description="Discard experiments whose peak VRAM exceeds this many GB.")


class Budget(StrictModel):
    max_experiments: int = Field(default=100, ge=1, le=10000, description="Stop after this many experiments (baseline included).")
    max_duration_minutes: Optional[int] = Field(default=None, ge=5, description="Stop starting new experiments after this much wall time.")
    experiment_timeout_minutes: int = Field(default=10, ge=1, le=120, description="Kill a single training run that exceeds this wall time.")


class Mission(StrictModel):
    """Declarative description of an autoresearch mission."""

    model_config = ConfigDict(extra="forbid", title="AutoresearchMission")

    schema_version: Literal["1"] = Field(default=SCHEMA_VERSION, description="Mission schema version.")
    mission_id: str = Field(default_factory=lambda: new_id("msn"), pattern=r"^[A-Za-z0-9_\-]{3,64}$", description="Unique id. Generated if omitted.")
    name: str = Field(..., min_length=1, max_length=120, description="Human-readable mission name shown in the dashboard.")
    tag: str = Field(
        ...,
        pattern=r"^[a-z0-9][a-z0-9\-]{0,40}$",
        description="Run tag. Work happens on branch autoresearch/<tag>; the branch must not already exist.",
    )
    objective: str = Field(default="Minimise val_bpb within the fixed 5-minute training budget.", max_length=2000)
    base_ref: str = Field(default="master", min_length=1, max_length=120, description="Git ref to branch from.")
    strategy: Strategy = Field(..., description="How experiments are proposed.")
    keep_policy: KeepPolicy = Field(default_factory=KeepPolicy)
    budget: Budget = Field(default_factory=Budget)
    requested_by: Optional[str] = Field(default=None, max_length=200, description="Identity of the requester (filled from SSO by the dashboard).")
    tags: List[str] = Field(default_factory=list, max_length=20, description="Free-form labels for filtering in the dashboard.")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Opaque passthrough data stored with the mission.")


# ---------------------------------------------------------------------------
# Commands (queue messages)
# ---------------------------------------------------------------------------

class CommandBase(StrictModel):
    schema_version: Literal["1"] = SCHEMA_VERSION
    request_id: str = Field(default_factory=lambda: new_id("req"), description="Idempotency key; duplicate deliveries are ignored.")
    issued_at: datetime = Field(default_factory=utcnow)
    issued_by: Optional[str] = Field(default=None, max_length=200)


class StartMission(CommandBase):
    command: Literal["start_mission"]
    mission: Mission


class MissionTargetCommand(CommandBase):
    mission_id: str = Field(..., pattern=r"^[A-Za-z0-9_\-]{3,64}$")


class PauseMission(MissionTargetCommand):
    command: Literal["pause_mission"]


class ResumeMission(MissionTargetCommand):
    command: Literal["resume_mission"]


class StopMission(MissionTargetCommand):
    """Finish the current experiment, record it, then end the mission."""

    command: Literal["stop_mission"]


class CancelMission(MissionTargetCommand):
    """Kill the running experiment immediately (or drop a queued mission)."""

    command: Literal["cancel_mission"]


class Ping(CommandBase):
    command: Literal["ping"]


class PublishSchema(CommandBase):
    command: Literal["publish_schema"]


Command = Annotated[
    Union[StartMission, PauseMission, ResumeMission, StopMission, CancelMission, Ping, PublishSchema],
    Field(discriminator="command"),
]


class CommandEnvelope(BaseModel):
    """Wrapper used only to validate/parse an arbitrary command payload."""

    model_config = ConfigDict(extra="forbid", title="AutoresearchCommand")
    root: Command

    @model_validator(mode="before")
    @classmethod
    def _wrap(cls, data: Any) -> Any:
        if isinstance(data, dict) and "root" not in data:
            return {"root": data}
        return data


def parse_command(payload: Any) -> Command:
    return CommandEnvelope.model_validate(payload).root


def mission_json_schema() -> Dict[str, Any]:
    schema = Mission.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = "https://autoresearch/schema/mission.schema.json"
    schema["description"] = "Autoresearch mission: declarative description of an autonomous research run."
    schema["x-overridable-hyperparameters"] = list(OVERRIDABLE_HYPERPARAMETERS)
    schema["examples"] = [example_mission().model_dump(mode="json")]
    return schema


def command_json_schema() -> Dict[str, Any]:
    # Expose the discriminated union directly rather than the {"root": ...} wrapper.
    schema = CommandEnvelope.model_json_schema()
    root_ref = schema["properties"]["root"]
    out: Dict[str, Any] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://autoresearch/schema/command.schema.json",
        "title": "AutoresearchCommand",
        "description": "Message queue command envelope consumed by the autoresearch service.",
        "$defs": schema.get("$defs", {}),
    }
    out.update({k: v for k, v in root_ref.items() if k != "title"})
    return out


def example_mission() -> Mission:
    return Mission(
        mission_id="msn_example00001",
        name="LR and batch-size sweep",
        tag="oct6-lr",
        strategy=SweepStrategy(
            experiments=[
                SweepExperiment(description="increase MATRIX_LR to 0.05", overrides={"MATRIX_LR": 0.05}),
                SweepExperiment(description="halve TOTAL_BATCH_SIZE", overrides={"TOTAL_BATCH_SIZE": 2**18}),
                SweepExperiment(description="depth 10", overrides={"DEPTH": 10, "DEVICE_BATCH_SIZE": 64}),
            ]
        ),
        budget=Budget(max_experiments=4),
        requested_by="researcher@example.com",
        tags=["sweep", "baseline-check"],
    )
