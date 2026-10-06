import json

import pytest
from pydantic import ValidationError

from autoresearch_service.schema import (
    Mission,
    StartMission,
    command_json_schema,
    example_mission,
    mission_json_schema,
    parse_command,
)


def test_example_mission_roundtrips():
    mission = example_mission()
    again = Mission.model_validate_json(mission.model_dump_json())
    assert again == mission
    assert again.strategy.type == "sweep"


def test_mission_id_is_generated():
    m = Mission(name="x", tag="t1", strategy={"type": "sweep", "experiments": [{"description": "a"}]})
    assert m.mission_id.startswith("msn_")


def test_unknown_override_rejected():
    with pytest.raises(ValidationError) as exc:
        Mission(name="x", tag="t1", strategy={"type": "sweep", "experiments": [{"description": "a", "overrides": {"EVAL_TOKENS": 1}}]})
    assert "unknown hyperparameters" in str(exc.value)


def test_extra_fields_rejected():
    with pytest.raises(ValidationError):
        Mission(name="x", tag="t1", strategy={"type": "sweep", "experiments": [{"description": "a"}]}, bogus=1)


def test_bad_tag_rejected():
    with pytest.raises(ValidationError):
        Mission(name="x", tag="Has Spaces", strategy={"type": "sweep", "experiments": [{"description": "a"}]})


def test_agent_strategy():
    m = Mission(name="x", tag="agent1", strategy={"type": "agent", "command": ["claude", "-p", "@{prompt_file}"]})
    assert m.strategy.timeout_minutes == 20


def test_parse_commands():
    start = parse_command({"command": "start_mission", "mission": json.loads(example_mission().model_dump_json())})
    assert isinstance(start, StartMission)
    assert start.request_id.startswith("req_")
    pause = parse_command({"command": "pause_mission", "mission_id": "msn_example00001"})
    assert pause.command == "pause_mission"
    with pytest.raises(ValidationError):
        parse_command({"command": "launch_rockets"})
    with pytest.raises(ValidationError):
        parse_command({"command": "pause_mission"})


def test_json_schemas_are_well_formed():
    mission_schema = mission_json_schema()
    assert mission_schema["title"] == "AutoresearchMission"
    assert "strategy" in mission_schema["required"]
    assert mission_schema["examples"][0]["mission_id"] == "msn_example00001"
    assert "MATRIX_LR" in mission_schema["x-overridable-hyperparameters"]
    assert mission_schema["x-hyperparameter-placeholders"]["MATRIX_LR"] == "0.04"
    assert mission_schema["properties"]["tag"]["examples"] == ["oct6-lr"]
    assert mission_schema["properties"]["name"]["examples"] == ["LR and batch-size sweep"]

    command_schema = command_json_schema()
    assert command_schema["title"] == "AutoresearchCommand"
    names = {ref["$ref"].rsplit("/", 1)[-1] for ref in command_schema["oneOf"]}
    assert {"StartMission", "PauseMission", "CancelMission", "Ping"} <= names
    commands = {ex["command"] for ex in command_schema["examples"]}
    assert {"start_mission", "pause_mission", "cancel_mission", "ping", "publish_schema"} <= commands
    assert command_schema["examples"][0]["mission"]["tag"] == "oct6-lr"
    # Both documents must be JSON-serialisable as-is.
    json.dumps(mission_schema)
    json.dumps(command_schema)
