"""
The mission service: polls the command queue, dispatches commands, runs one
mission at a time on the local GPU, and publishes state to the result store.
"""

from __future__ import annotations

import logging
import platform
import shutil
import socket
import subprocess
import threading
import time
from collections import OrderedDict, deque
from typing import Deque, Dict, Optional

from pydantic import ValidationError

from . import __version__
from .config import ServiceConfig
from .queues import MessageQueue, QueueMessage, queue_from_url
from .records import TERMINAL_STATES, MissionRecord, ServiceStatus
from .runner import MissionControl, MissionRunner, RunnerConfig
from .schema import (
    CancelMission,
    Command,
    PauseMission,
    Ping,
    PublishSchema,
    ResumeMission,
    StartMission,
    StopMission,
    new_id,
    parse_command,
    utcnow,
)
from .store import ResultStore, store_from_url

log = logging.getLogger("autoresearch.service")


def detect_gpu() -> Optional[str]:
    if shutil.which("nvidia-smi") is None:
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True, timeout=10
        )
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
    except (subprocess.SubprocessError, OSError):
        return None


class MissionService:
    def __init__(self, config: ServiceConfig, queue: Optional[MessageQueue] = None, store: Optional[ResultStore] = None):
        self.config = config
        self.queue = queue or queue_from_url(config.queue_url)
        self.store = store or store_from_url(config.store_url)
        self.runner_config = RunnerConfig(
            repo_dir=config.repo_dir,
            worktrees_dir=config.resolved_worktrees_dir(),
            train_command=config.resolved_train_command(),
        )
        self.status = ServiceStatus(
            service_id=config.service_id or new_id("svc"),
            host=socket.gethostname() or platform.node(),
            version=__version__,
            started_at=utcnow(),
            queue=self.queue.url,
            store=self.store.url,
            gpu=detect_gpu(),
        )
        self._lock = threading.RLock()
        self.missions: Dict[str, MissionRecord] = OrderedDict()
        self.pending: Deque[str] = deque()
        self.current: Optional[MissionRecord] = None
        self.control: Optional[MissionControl] = None
        self._thread: Optional[threading.Thread] = None
        self._seen_requests: "OrderedDict[str, None]" = OrderedDict()
        self._shutdown = threading.Event()
        self._last_heartbeat = 0.0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        self._recover()
        self.store.publish_schemas()
        self._publish_index(force=True)
        log.info("service %s listening on %s, publishing to %s", self.status.service_id, self.queue.url, self.store.url)

    def run_forever(self) -> None:
        self.start()
        while not self._shutdown.is_set():
            self.tick()

    def shutdown(self) -> None:
        self._shutdown.set()

    def tick(self, wait_seconds: Optional[int] = None) -> None:
        """One iteration: receive + dispatch commands, advance the mission queue, heartbeat."""
        wait = self.config.poll_seconds if wait_seconds is None else wait_seconds
        for message in self.queue.receive(max_messages=10, wait_seconds=wait):
            self._handle_message(message)
        self._advance()
        self._publish_index()

    # -- recovery ----------------------------------------------------------

    def _recover(self) -> None:
        """Reload history from the store; anything that was mid-flight when we died is marked failed."""
        for record in self.store.load_all_missions():
            if record.state not in TERMINAL_STATES:
                if record.state == "queued":
                    self.pending.append(record.mission.mission_id)
                else:
                    record.state = "failed"
                    record.error = "service restarted while mission was in progress"
                    record.finished_at = utcnow()
                    record.log(record.error, level="error")
                    self.store.save_mission(record)
            self.missions[record.mission.mission_id] = record

    # -- command handling --------------------------------------------------

    def _handle_message(self, message: QueueMessage) -> None:
        try:
            command = parse_command(message.body)
        except ValidationError as exc:
            log.warning("dropping invalid command %s: %s", message.id, exc.errors()[:3])
            self.queue.ack(message)
            self._record_command(message.body, ok=False, error=str(exc)[:500])
            return
        if command.request_id in self._seen_requests:
            log.info("duplicate request %s ignored", command.request_id)
            self.queue.ack(message)
            self._record_command(message.body, ok=True, result="duplicate request ignored")
            return
        try:
            result = self.handle_command(command)
        except Exception as exc:  # noqa: BLE001
            log.exception("command %s failed", command.command)
            self.queue.nack(message)
            self._record_command(message.body, ok=False, error=f"{type(exc).__name__}: {exc}")
            return
        self._remember(command.request_id)
        self.queue.ack(message)
        self._record_command(message.body, ok=True, result=result)

    def _remember(self, request_id: str) -> None:
        self._seen_requests[request_id] = None
        while len(self._seen_requests) > 5000:
            self._seen_requests.popitem(last=False)

    def _record_command(self, body: dict, ok: bool, result: Optional[str] = None, error: Optional[str] = None) -> None:
        self.status.commands_processed += 1
        self.status.last_command = {
            "command": body.get("command") if isinstance(body, dict) else None,
            "request_id": body.get("request_id") if isinstance(body, dict) else None,
            "issued_by": body.get("issued_by") if isinstance(body, dict) else None,
            "received_at": utcnow().isoformat(),
            "ok": ok,
            "result": result,
            "error": error,
        }
        self._publish_index(force=True)

    def handle_command(self, command: Command) -> str:
        with self._lock:
            if isinstance(command, StartMission):
                return self._start_mission(command)
            if isinstance(command, Ping):
                return "pong"
            if isinstance(command, PublishSchema):
                self.store.publish_schemas()
                return "schemas published"
            record = self.missions.get(command.mission_id)
            if record is None:
                return f"unknown mission {command.mission_id}"
            if isinstance(command, CancelMission):
                return self._cancel(record)
            if isinstance(command, StopMission):
                return self._stop(record)
            if isinstance(command, PauseMission):
                return self._pause(record)
            if isinstance(command, ResumeMission):
                return self._resume(record)
            return f"unhandled command {command.command}"  # pragma: no cover

    def _start_mission(self, command: StartMission) -> str:
        mission = command.mission
        if mission.mission_id in self.missions:
            return f"mission {mission.mission_id} already exists"
        if mission.requested_by is None and command.issued_by:
            mission = mission.model_copy(update={"requested_by": command.issued_by})
        record = MissionRecord(mission=mission, host=self.status.host)
        record.log(f"Mission queued by {command.issued_by or 'unknown'} (request {command.request_id}).")
        self.missions[mission.mission_id] = record
        self.pending.append(mission.mission_id)
        self.store.save_mission(record)
        return f"mission {mission.mission_id} queued at position {len(self.pending)}"

    def _cancel(self, record: MissionRecord) -> str:
        mid = record.mission.mission_id
        if record.state in TERMINAL_STATES:
            return f"mission {mid} already {record.state}"
        if record.state == "queued":
            self.pending.remove(mid)
            record.state = "cancelled"
            record.finished_at = utcnow()
            record.log("Cancelled before start.", level="warning")
            self.store.save_mission(record)
            return f"mission {mid} removed from queue"
        assert self.control is not None
        self.control.cancel.set()
        self.control.pause.clear()
        self.control.kill_running()
        record.log("Cancel requested; killing running experiment.", level="warning")
        self.store.save_mission(record)
        return f"mission {mid} cancelling"

    def _stop(self, record: MissionRecord) -> str:
        mid = record.mission.mission_id
        if record.state in TERMINAL_STATES:
            return f"mission {mid} already {record.state}"
        if record.state == "queued":
            return self._cancel(record)
        assert self.control is not None
        self.control.stop.set()
        self.control.pause.clear()
        record.state = "stopping"
        record.log("Stop requested; will finish the current experiment and end.")
        self.store.save_mission(record)
        return f"mission {mid} stopping after current experiment"

    def _pause(self, record: MissionRecord) -> str:
        mid = record.mission.mission_id
        if record.state != "running" or self.control is None:
            return f"mission {mid} is {record.state}; cannot pause"
        self.control.pause.set()
        record.log("Pause requested; will pause after the current experiment.")
        self.store.save_mission(record)
        return f"mission {mid} pausing after current experiment"

    def _resume(self, record: MissionRecord) -> str:
        mid = record.mission.mission_id
        if record.state not in ("paused", "running") or self.control is None:
            return f"mission {mid} is {record.state}; cannot resume"
        self.control.pause.clear()
        return f"mission {mid} resuming"

    # -- mission scheduling -----------------------------------------------

    def _advance(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if self.current is not None:
                self.store.save_mission(self.current)
                self.current = None
                self.control = None
                self._thread = None
            if not self.pending:
                return
            mission_id = self.pending.popleft()
            record = self.missions[mission_id]
            self.current = record
            self.control = MissionControl()
            runner = MissionRunner(self.runner_config, record, self.control, on_update=self._on_runner_update)
            self._thread = threading.Thread(target=runner.run, name=f"mission-{mission_id}", daemon=True)
            self._thread.start()
            log.info("started mission %s (%s)", mission_id, record.mission.name)

    def _on_runner_update(self, record: MissionRecord) -> None:
        with self._lock:
            self.store.save_mission(record)
        self._publish_index()

    def wait_for_idle(self, timeout: Optional[float] = None) -> bool:
        """Block until the running mission (if any) finishes. Used by tests and graceful shutdown."""
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    # -- publishing --------------------------------------------------------

    def _publish_index(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_heartbeat < self.config.heartbeat_seconds:
            return
        self._last_heartbeat = now
        with self._lock:
            self.status.last_heartbeat = utcnow()
            self.status.current_mission_id = self.current.mission.mission_id if self.current else None
            self.status.queued_mission_ids = list(self.pending)
            self.store.save_index(self.status, list(self.missions.values()))
