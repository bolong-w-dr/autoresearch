"""
Message queue backends.

All backends expose the same tiny at-least-once interface: ``receive`` returns
messages that stay invisible until ``ack``/``nack``. The service deduplicates
on ``request_id`` so redelivery is harmless.

Backends are selected from a URL:

    https://sqs.<region>.amazonaws.com/<account>/<queue>   -> SqsQueue
    redis://host:6379/0?key=autoresearch:commands           -> RedisQueue
    file:///abs/path/to/queue-dir  (or a plain path)        -> LocalDirQueue
"""

from __future__ import annotations

import json
import os
import shutil
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse


@dataclass
class QueueMessage:
    id: str
    body: Dict[str, Any]
    receipt: Any = None
    attributes: Dict[str, Any] = field(default_factory=dict)


class MessageQueue(ABC):
    url: str

    @abstractmethod
    def receive(self, max_messages: int = 10, wait_seconds: int = 10) -> List[QueueMessage]:
        ...

    @abstractmethod
    def ack(self, message: QueueMessage) -> None:
        ...

    @abstractmethod
    def nack(self, message: QueueMessage) -> None:
        """Make the message visible again for another attempt."""

    @abstractmethod
    def send(self, body: Dict[str, Any]) -> str:
        ...

    def close(self) -> None:
        pass


def _decode(raw: str) -> Dict[str, Any]:
    body = json.loads(raw)
    # SNS -> SQS subscriptions wrap the payload in a notification envelope.
    if isinstance(body, dict) and body.get("Type") == "Notification" and "Message" in body:
        body = json.loads(body["Message"])
    if not isinstance(body, dict):
        raise ValueError("message body must be a JSON object")
    return body


# ---------------------------------------------------------------------------
# Local directory queue (development / tests / single-host)
# ---------------------------------------------------------------------------

class LocalDirQueue(MessageQueue):
    """Directory-backed queue: ``new/`` holds pending messages, ``inflight/`` claimed ones."""

    def __init__(self, path: os.PathLike | str):
        self.root = Path(path)
        self.new = self.root / "new"
        self.inflight = self.root / "inflight"
        self.failed = self.root / "failed"
        for d in (self.new, self.inflight, self.failed):
            d.mkdir(parents=True, exist_ok=True)
        self.url = self.root.resolve().as_uri()

    def send(self, body: Dict[str, Any]) -> str:
        msg_id = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
        tmp = self.new / f".{msg_id}.tmp"
        tmp.write_text(json.dumps(body, default=str))
        os.replace(tmp, self.new / f"{msg_id}.json")
        return msg_id

    def receive(self, max_messages: int = 10, wait_seconds: int = 10) -> List[QueueMessage]:
        deadline = time.monotonic() + wait_seconds
        while True:
            files = sorted(p for p in self.new.glob("*.json"))[:max_messages]
            out: List[QueueMessage] = []
            for path in files:
                target = self.inflight / path.name
                try:
                    os.replace(path, target)
                except FileNotFoundError:
                    continue
                try:
                    body = _decode(target.read_text())
                except (ValueError, json.JSONDecodeError):
                    shutil.move(str(target), self.failed / path.name)
                    continue
                out.append(QueueMessage(id=path.stem, body=body, receipt=target))
            if out or time.monotonic() >= deadline:
                return out
            time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))

    def ack(self, message: QueueMessage) -> None:
        try:
            Path(message.receipt).unlink()
        except FileNotFoundError:
            pass

    def nack(self, message: QueueMessage) -> None:
        src = Path(message.receipt)
        if src.exists():
            os.replace(src, self.new / src.name)


# ---------------------------------------------------------------------------
# Amazon SQS
# ---------------------------------------------------------------------------

class SqsQueue(MessageQueue):
    def __init__(self, queue_url: str, client: Any = None, visibility_timeout: int = 120):
        if client is None:
            import boto3  # lazy: boto3 only required when SQS/S3 are used

            region = self._region_from_url(queue_url)
            client = boto3.client("sqs", region_name=region) if region else boto3.client("sqs")
        self.client = client
        self.url = queue_url
        self.visibility_timeout = visibility_timeout
        self._is_fifo = queue_url.endswith(".fifo")

    @staticmethod
    def _region_from_url(url: str) -> Optional[str]:
        host = urlparse(url).hostname or ""
        parts = host.split(".")
        if len(parts) >= 2 and parts[0] == "sqs":
            return parts[1]
        return None

    def send(self, body: Dict[str, Any]) -> str:
        kwargs: Dict[str, Any] = {"QueueUrl": self.url, "MessageBody": json.dumps(body, default=str)}
        if self._is_fifo:
            kwargs["MessageGroupId"] = "autoresearch"
            kwargs["MessageDeduplicationId"] = str(body.get("request_id") or uuid.uuid4())
        return self.client.send_message(**kwargs)["MessageId"]

    def receive(self, max_messages: int = 10, wait_seconds: int = 10) -> List[QueueMessage]:
        resp = self.client.receive_message(
            QueueUrl=self.url,
            MaxNumberOfMessages=max(1, min(10, max_messages)),
            WaitTimeSeconds=max(0, min(20, wait_seconds)),
            VisibilityTimeout=self.visibility_timeout,
            MessageAttributeNames=["All"],
            AttributeNames=["ApproximateReceiveCount", "SentTimestamp"],
        )
        out: List[QueueMessage] = []
        for m in resp.get("Messages", []):
            try:
                body = _decode(m["Body"])
            except (ValueError, json.JSONDecodeError):
                # Poison message: delete so it does not loop forever (DLQ policy handles retries for valid JSON).
                self.client.delete_message(QueueUrl=self.url, ReceiptHandle=m["ReceiptHandle"])
                continue
            out.append(QueueMessage(id=m["MessageId"], body=body, receipt=m["ReceiptHandle"], attributes=m.get("Attributes", {})))
        return out

    def ack(self, message: QueueMessage) -> None:
        self.client.delete_message(QueueUrl=self.url, ReceiptHandle=message.receipt)

    def nack(self, message: QueueMessage) -> None:
        self.client.change_message_visibility(QueueUrl=self.url, ReceiptHandle=message.receipt, VisibilityTimeout=0)


# ---------------------------------------------------------------------------
# Redis (list + processing list, a.k.a. reliable queue pattern)
# ---------------------------------------------------------------------------

class RedisQueue(MessageQueue):
    def __init__(self, url: str, client: Any = None, key: str = "autoresearch:commands"):
        if client is None:
            import redis  # optional dependency

            client = redis.Redis.from_url(url)
        self.client = client
        self.url = url
        self.key = key
        self.processing_key = f"{key}:processing"

    def send(self, body: Dict[str, Any]) -> str:
        msg_id = uuid.uuid4().hex
        self.client.rpush(self.key, json.dumps({"id": msg_id, "body": body}, default=str))
        return msg_id

    def receive(self, max_messages: int = 10, wait_seconds: int = 10) -> List[QueueMessage]:
        out: List[QueueMessage] = []
        raw = self.client.blmove(self.key, self.processing_key, max(1, wait_seconds), "LEFT", "RIGHT")
        while raw is not None:
            text = raw.decode() if isinstance(raw, bytes) else raw
            try:
                wrapped = json.loads(text)
                body = _decode(json.dumps(wrapped["body"]))
                out.append(QueueMessage(id=wrapped["id"], body=body, receipt=text))
            except (ValueError, KeyError, json.JSONDecodeError):
                self.client.lrem(self.processing_key, 1, text)
            if len(out) >= max_messages:
                break
            raw = self.client.lmove(self.key, self.processing_key, "LEFT", "RIGHT")
        return out

    def ack(self, message: QueueMessage) -> None:
        self.client.lrem(self.processing_key, 1, message.receipt)

    def nack(self, message: QueueMessage) -> None:
        with self.client.pipeline() as pipe:
            pipe.lrem(self.processing_key, 1, message.receipt)
            pipe.lpush(self.key, message.receipt)
            pipe.execute()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def queue_from_url(url: str) -> MessageQueue:
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https") and (parsed.hostname or "").startswith("sqs."):
        return SqsQueue(url)
    if parsed.scheme in ("redis", "rediss"):
        key = parse_qs(parsed.query).get("key", ["autoresearch:commands"])[0]
        clean = url.split("?", 1)[0]
        return RedisQueue(clean, key=key)
    if parsed.scheme == "file":
        return LocalDirQueue(parsed.path)
    if parsed.scheme == "":
        return LocalDirQueue(url)
    raise ValueError(f"unsupported queue url: {url}")
