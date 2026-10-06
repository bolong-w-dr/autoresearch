import json
import time
import urllib.request
from pathlib import Path

from autoresearch_service.config import ServiceConfig
from autoresearch_service.devserver import default_dashboard_dir, make_server, serve_in_thread
from autoresearch_service.queues import LocalDirQueue
from autoresearch_service.records import MissionRecord
from autoresearch_service.schema import Mission, parse_command
from autoresearch_service.service import MissionService
from autoresearch_service.store import LocalFileStore


def make_service(repo: Path, train_command, tmp_path: Path) -> MissionService:
    config = ServiceConfig(
        repo_dir=repo,
        queue_url=str(tmp_path / "queue"),
        store_url=str(tmp_path / "data"),
        worktrees_dir=tmp_path / "worktrees",
        train_command=train_command,
        poll_seconds=0,
        heartbeat_seconds=0,
    )
    return MissionService(config)


def sweep_mission(tag: str, n: int = 3) -> dict:
    return json.loads(
        Mission(
            name=f"mission {tag}",
            tag=tag,
            strategy={"type": "sweep", "experiments": [{"description": f"e{i}", "overrides": {"MATRIX_LR": 0.041 + i / 1000}} for i in range(n)]},
            budget={"max_experiments": n + 1, "experiment_timeout_minutes": 1},
        ).model_dump_json()
    )


def pump(service: MissionService, until, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        service.tick(wait_seconds=0)
        if until():
            return
        time.sleep(0.05)
    raise AssertionError("condition not met in time")


def test_end_to_end_mission_via_queue(repo, train_command, tmp_path):
    service = make_service(repo, train_command, tmp_path)
    service.start()
    queue = service.queue
    assert isinstance(queue, LocalDirQueue)

    # Schema is published on start-up.
    assert json.loads(service.store.read_text("schema/mission.schema.json"))["title"] == "AutoresearchMission"

    queue.send({"command": "ping", "request_id": "req_ping", "issued_by": "alice@example.com"})
    queue.send({"command": "start_mission", "request_id": "req_start", "issued_by": "alice@example.com", "mission": sweep_mission("e2e")})
    queue.send({"command": "start_mission", "request_id": "req_start", "mission": sweep_mission("dupe")})  # duplicate request id
    queue.send({"command": "pause_mission", "mission_id": "msn_unknown0000"})
    queue.send({"command": "nonsense"})

    pump(service, lambda: service.current is not None)
    mission_id = service.current.mission.mission_id
    assert service.current.mission.requested_by == "alice@example.com"
    assert len(service.missions) == 1  # duplicate request ignored

    pump(service, lambda: service.missions[mission_id].state == "completed" and service.current is None, timeout=60)
    record = service.store.load_mission(mission_id)
    assert record.state == "completed"
    assert [e.status for e in record.experiments] == ["keep", "keep", "keep", "keep"]

    index = json.loads(service.store.read_text("index.json"))
    assert index["missions"][0]["state"] == "completed"
    assert index["service"]["commands_processed"] == 5
    assert index["service"]["current_mission_id"] is None
    # The queue is drained: everything was acked.
    assert queue.receive(wait_seconds=0) == [] and not list(queue.inflight.glob("*.json"))


def test_pause_resume_stop_and_cancel(repo, train_command, tmp_path):
    service = make_service(repo, train_command, tmp_path)
    service.start()
    q = service.queue

    long_mission = sweep_mission("long", n=50)
    long_mission["budget"]["max_experiments"] = 60
    q.send({"command": "start_mission", "mission": long_mission})
    queued = sweep_mission("queued", n=50)
    queued["budget"]["max_experiments"] = 60
    q.send({"command": "start_mission", "mission": queued})
    pump(service, lambda: service.current is not None and len(service.current.experiments) >= 1)
    running_id = service.current.mission.mission_id
    assert list(service.pending) == [queued["mission_id"]]

    q.send({"command": "pause_mission", "mission_id": running_id})
    pump(service, lambda: service.missions[running_id].state == "paused", timeout=60)
    n_at_pause = len(service.missions[running_id].experiments)
    time.sleep(0.5)
    assert len(service.missions[running_id].experiments) == n_at_pause

    q.send({"command": "resume_mission", "mission_id": running_id})
    pump(service, lambda: len(service.missions[running_id].experiments) > n_at_pause, timeout=60)

    q.send({"command": "stop_mission", "mission_id": running_id})
    pump(service, lambda: service.missions[running_id].state == "stopped", timeout=60)
    assert all(e.status != "running" for e in service.missions[running_id].experiments)

    # The queued mission starts next; cancel it mid-flight.
    pump(
        service,
        lambda: service.current is not None and service.current.mission.mission_id == queued["mission_id"] and len(service.current.experiments) >= 2,
        timeout=60,
    )
    q.send({"command": "cancel_mission", "mission_id": queued["mission_id"]})
    pump(service, lambda: service.missions[queued["mission_id"]].state == "cancelled" and service.current is None, timeout=60)
    cancelled = service.missions[queued["mission_id"]]
    assert cancelled.finished_at is not None
    assert all(e.status != "running" for e in cancelled.experiments)
    assert len(cancelled.experiments) < 60

    # Cancelling a never-started mission just drops it.
    extra = sweep_mission("extra", n=1)
    service.handle_command(parse_command({"command": "start_mission", "mission": extra}))
    result = service.handle_command(parse_command({"command": "cancel_mission", "mission_id": extra["mission_id"]}))
    assert result == f"mission {extra['mission_id']} removed from queue"
    assert service.missions[extra["mission_id"]].state == "cancelled"


def test_recovery_marks_interrupted_missions_failed(repo, train_command, tmp_path):
    store = LocalFileStore(tmp_path / "data")
    running = MissionRecord(mission=Mission.model_validate(sweep_mission("was-running")), state="running")
    queued = MissionRecord(mission=Mission.model_validate(sweep_mission("was-queued")), state="queued")
    store.save_mission(running)
    store.save_mission(queued)

    service = make_service(repo, train_command, tmp_path)
    service.start()
    assert service.missions[running.mission.mission_id].state == "failed"
    assert list(service.pending) == [queued.mission.mission_id]


def test_devserver_serves_dashboard_data_and_accepts_commands(repo, train_command, tmp_path):
    service = make_service(repo, train_command, tmp_path)
    service.start()
    server = make_server(default_dashboard_dir(), service.store, service.queue, port=0)
    serve_in_thread(server)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        html = urllib.request.urlopen(f"{base}/").read().decode()
        assert "<title>" in html and "app.js" in html
        index = json.loads(urllib.request.urlopen(f"{base}/data/index.json").read())
        assert index["service"]["service_id"].startswith("svc_")
        schema = json.loads(urllib.request.urlopen(f"{base}/data/schema/mission.schema.json").read())
        assert schema["title"] == "AutoresearchMission"
        me = json.loads(urllib.request.urlopen(f"{base}/api/me").read())
        assert me["auth"] == "devserver"

        body = json.dumps({"command": "start_mission", "mission": sweep_mission("via-http", n=1)}).encode()
        req = urllib.request.Request(f"{base}/api/commands", data=body, headers={"Content-Type": "application/json"}, method="POST")
        resp = json.loads(urllib.request.urlopen(req).read())
        assert resp["accepted"] and resp["request_id"].startswith("req_")

        bad = urllib.request.Request(f"{base}/api/commands", data=b'{"command": "nope"}', headers={"Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(bad)
            raise AssertionError("expected 400")
        except urllib.error.HTTPError as err:
            assert err.code == 400

        pump(service, lambda: any(r.state == "completed" for r in service.missions.values()) and service.current is None, timeout=60)
        record = next(iter(service.missions.values()))
        assert record.mission.requested_by == "dev@localhost"
    finally:
        server.shutdown()
