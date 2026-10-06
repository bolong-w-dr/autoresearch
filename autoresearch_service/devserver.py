"""
Local stand-in for the AWS edge (CloudFront + API Gateway) used in development.

Serves the static dashboard, exposes the result store under ``/data/`` and
accepts ``POST /api/commands`` by writing the command to the configured queue.
No authentication: this is for a developer laptop or a GPU box behind a VPN.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import threading
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from .queues import MessageQueue
from .schema import parse_command
from .store import ResultStore

log = logging.getLogger("autoresearch.devserver")


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "autoresearch-devserver/0.1"

    def __init__(self, *args, dashboard_dir: Path, store: ResultStore, queue: MessageQueue, user: str, **kwargs):
        self.store = store
        self.queue = queue
        self.user = user
        super().__init__(*args, directory=str(dashboard_dir), **kwargs)

    def log_message(self, fmt, *args):  # noqa: A003 - keep http.server quiet
        log.debug(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path.startswith("/data/"):
            return self._serve_data(path[len("/data/"):])
        if path == "/api/me":
            return self._json(HTTPStatus.OK, {"user": self.user, "auth": "devserver"})
        if path.startswith("/auth/"):
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/")
            self.end_headers()
            return None
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        if self.path.split("?", 1)[0] != "/api/commands":
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
            if isinstance(body, dict) and not body.get("issued_by"):
                body["issued_by"] = self.user
            command = parse_command(body)
        except (json.JSONDecodeError, ValidationError) as exc:
            detail = exc.errors() if isinstance(exc, ValidationError) else str(exc)
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid command", "detail": json.loads(json.dumps(detail, default=str))})
        message_id = self.queue.send(json.loads(command.model_dump_json()))
        return self._json(HTTPStatus.ACCEPTED, {"accepted": True, "message_id": message_id, "request_id": command.request_id})

    def _serve_data(self, key: str) -> None:
        if ".." in key or key.startswith("/"):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "bad key"})
        text = self.store.read_text(key)
        if text is None:
            return self._json(HTTPStatus.NOT_FOUND, {"error": f"{key} not found"})
        payload = text.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(key)[0] or "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status: HTTPStatus, obj) -> None:
        payload = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def make_server(dashboard_dir: Path, store: ResultStore, queue: MessageQueue, host: str = "127.0.0.1", port: int = 8080, user: str = "dev@localhost") -> ThreadingHTTPServer:
    handler = partial(DashboardHandler, dashboard_dir=dashboard_dir, store=store, queue=queue, user=user)
    return ThreadingHTTPServer((host, port), handler)


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, name="devserver", daemon=True)
    thread.start()
    return thread


def default_dashboard_dir(repo_dir: Optional[Path] = None) -> Path:
    """Locate the static dashboard: explicit env override, else next to this package, else in the repo."""
    override = os.environ.get("AUTORESEARCH_DASHBOARD_DIR")
    if override:
        return Path(override)
    packaged = Path(__file__).resolve().parent.parent / "dashboard"
    if packaged.is_dir() or repo_dir is None:
        return packaged
    return repo_dir / "dashboard"
