"""
Command line entry point.

    python -m autoresearch_service run        # consume the queue and run missions
    python -m autoresearch_service schema     # print the mission (or command) JSON Schema
    python -m autoresearch_service send ...   # enqueue a command (for local testing / scripting)
    python -m autoresearch_service devserver  # serve the dashboard locally against a local store/queue
    python -m autoresearch_service example    # print an example mission
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
from pathlib import Path

from .config import ServiceConfig
from .devserver import default_dashboard_dir, make_server
from .queues import queue_from_url
from .schema import (
    CancelMission,
    Mission,
    PauseMission,
    Ping,
    PublishSchema,
    ResumeMission,
    StartMission,
    StopMission,
    command_json_schema,
    example_mission,
    mission_json_schema,
)
from .service import MissionService
from .store import store_from_url


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo-dir", type=Path, help="Path to the autoresearch checkout (default: AUTORESEARCH_REPO_DIR or cwd)")
    parser.add_argument("--queue-url", help="SQS URL, redis:// URL, or local directory (default: AUTORESEARCH_QUEUE_URL or ./queue)")
    parser.add_argument("--store-url", help="s3://bucket/prefix or local directory (default: AUTORESEARCH_STORE_URL or ./results)")


def _config(args: argparse.Namespace) -> ServiceConfig:
    config = ServiceConfig()
    if getattr(args, "repo_dir", None):
        config.repo_dir = args.repo_dir.resolve()
    if getattr(args, "queue_url", None):
        config.queue_url = args.queue_url
    if getattr(args, "store_url", None):
        config.store_url = args.store_url
    if getattr(args, "train_command", None):
        config.train_command = args.train_command
    if getattr(args, "poll_seconds", None) is not None:
        config.poll_seconds = args.poll_seconds
    if getattr(args, "heartbeat_seconds", None) is not None:
        config.heartbeat_seconds = args.heartbeat_seconds
    return config


def cmd_run(args: argparse.Namespace) -> int:
    config = _config(args)
    service = MissionService(config)
    signal.signal(signal.SIGTERM, lambda *_: service.shutdown())
    signal.signal(signal.SIGINT, lambda *_: service.shutdown())
    if args.with_devserver:
        server = make_server(default_dashboard_dir(config.repo_dir), service.store, service.queue, port=args.port)
        from .devserver import serve_in_thread

        serve_in_thread(server)
        logging.getLogger("autoresearch").info("dashboard available at http://127.0.0.1:%d/", args.port)
    service.run_forever()
    return 0


def cmd_schema(args: argparse.Namespace) -> int:
    schema = command_json_schema() if args.kind == "command" else mission_json_schema()
    json.dump(schema, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_example(args: argparse.Namespace) -> int:
    json.dump(json.loads(example_mission().model_dump_json()), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_send(args: argparse.Namespace) -> int:
    config = _config(args)
    queue = queue_from_url(config.queue_url)
    if args.command == "start_mission":
        if not args.mission:
            print("start_mission requires --mission <file.json>", file=sys.stderr)
            return 2
        mission = Mission.model_validate_json(Path(args.mission).read_text())
        command = StartMission(command="start_mission", mission=mission, issued_by=args.issued_by)
    elif args.command == "ping":
        command = Ping(command="ping", issued_by=args.issued_by)
    elif args.command == "publish_schema":
        command = PublishSchema(command="publish_schema", issued_by=args.issued_by)
    else:
        if not args.mission_id:
            print(f"{args.command} requires --mission-id", file=sys.stderr)
            return 2
        cls = {"pause_mission": PauseMission, "resume_mission": ResumeMission, "stop_mission": StopMission, "cancel_mission": CancelMission}[args.command]
        command = cls(command=args.command, mission_id=args.mission_id, issued_by=args.issued_by)
    message_id = queue.send(json.loads(command.model_dump_json()))
    print(json.dumps({"message_id": message_id, "request_id": command.request_id}))
    return 0


def cmd_devserver(args: argparse.Namespace) -> int:
    config = _config(args)
    store = store_from_url(config.store_url)
    store.publish_schemas()
    queue = queue_from_url(config.queue_url)
    server = make_server(default_dashboard_dir(config.repo_dir), store, queue, host=args.host, port=args.port)
    print(f"dashboard: http://{args.host}:{args.port}/  (store={store.url} queue={queue.url})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="autoresearch-service", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="consume the queue and run missions")
    _add_common(run)
    run.add_argument("--train-command", nargs=argparse.REMAINDER, help="override the training command (default: uv run --project <repo> python train.py)")
    run.add_argument("--poll-seconds", type=int)
    run.add_argument("--heartbeat-seconds", type=int)
    run.add_argument("--with-devserver", action="store_true", help="also serve the dashboard locally")
    run.add_argument("--port", type=int, default=8080)
    run.set_defaults(func=cmd_run)

    schema = sub.add_parser("schema", help="print JSON Schema")
    schema.add_argument("kind", nargs="?", choices=["mission", "command"], default="mission")
    schema.set_defaults(func=cmd_schema)

    example = sub.add_parser("example", help="print an example mission")
    example.set_defaults(func=cmd_example)

    send = sub.add_parser("send", help="enqueue a command")
    _add_common(send)
    send.add_argument("command", choices=["start_mission", "pause_mission", "resume_mission", "stop_mission", "cancel_mission", "ping", "publish_schema"])
    send.add_argument("--mission", help="mission JSON file (start_mission)")
    send.add_argument("--mission-id")
    send.add_argument("--issued-by", default=None)
    send.set_defaults(func=cmd_send)

    dev = sub.add_parser("devserver", help="serve dashboard + data + command endpoint locally")
    _add_common(dev)
    dev.add_argument("--host", default="127.0.0.1")
    dev.add_argument("--port", type=int, default=8080)
    dev.set_defaults(func=cmd_devserver)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
