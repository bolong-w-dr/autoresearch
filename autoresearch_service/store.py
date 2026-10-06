"""
Result store: where mission state, service status and the published schema
live. The dashboard reads these files verbatim, so the layout is the contract
between service and UI:

    <root>/index.json                       service status + mission summaries
    <root>/missions/<mission_id>.json       full MissionRecord
    <root>/schema/mission.schema.json       JSON Schema for a mission
    <root>/schema/command.schema.json       JSON Schema for a queue command

Backends: local filesystem (``file://`` or plain path) and S3 (``s3://bucket/prefix``).
"""

from __future__ import annotations

import json
import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from pydantic import BaseModel

from .records import MissionRecord, ServiceStatus
from .schema import command_json_schema, mission_json_schema

INDEX_KEY = "index.json"
MISSIONS_PREFIX = "missions/"
SCHEMA_PREFIX = "schema/"


def _dump(obj: Any) -> str:
    if isinstance(obj, BaseModel):
        return obj.model_dump_json(indent=2)
    return json.dumps(obj, indent=2, default=str)


class ResultStore(ABC):
    url: str

    @abstractmethod
    def write_text(self, key: str, text: str, content_type: str = "application/json") -> None:
        ...

    @abstractmethod
    def read_text(self, key: str) -> Optional[str]:
        ...

    @abstractmethod
    def list_keys(self, prefix: str) -> List[str]:
        ...

    # -- high level helpers ------------------------------------------------

    def save_mission(self, record: MissionRecord) -> None:
        self.write_text(f"{MISSIONS_PREFIX}{record.mission.mission_id}.json", _dump(record))

    def load_mission(self, mission_id: str) -> Optional[MissionRecord]:
        text = self.read_text(f"{MISSIONS_PREFIX}{mission_id}.json")
        return MissionRecord.model_validate_json(text) if text else None

    def load_all_missions(self) -> List[MissionRecord]:
        records: List[MissionRecord] = []
        for key in self.list_keys(MISSIONS_PREFIX):
            if not key.endswith(".json"):
                continue
            text = self.read_text(key)
            if text:
                try:
                    records.append(MissionRecord.model_validate_json(text))
                except ValueError:
                    continue
        records.sort(key=lambda r: r.created_at, reverse=True)
        return records

    def save_index(self, status: ServiceStatus, missions: List[MissionRecord]) -> None:
        payload = {
            "generated_at": status.last_heartbeat,
            "service": status.model_dump(mode="json"),
            "missions": [m.summary() for m in sorted(missions, key=lambda r: r.created_at, reverse=True)],
        }
        self.write_text(INDEX_KEY, _dump(payload))

    def publish_schemas(self) -> None:
        self.write_text(f"{SCHEMA_PREFIX}mission.schema.json", _dump(mission_json_schema()))
        self.write_text(f"{SCHEMA_PREFIX}command.schema.json", _dump(command_json_schema()))


class LocalFileStore(ResultStore):
    def __init__(self, root: os.PathLike | str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.url = self.root.resolve().as_uri()

    def write_text(self, key: str, text: str, content_type: str = "application/json") -> None:
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(text)
        os.replace(tmp, path)

    def read_text(self, key: str) -> Optional[str]:
        path = self.root / key
        return path.read_text() if path.exists() else None

    def list_keys(self, prefix: str) -> List[str]:
        base = self.root / prefix
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)) for p in base.rglob("*") if p.is_file() and not p.name.endswith(".tmp"))


class S3Store(ResultStore):
    def __init__(self, bucket: str, prefix: str = "data/", client: Any = None, cache_control: str = "no-cache"):
        if client is None:
            import boto3

            client = boto3.client("s3")
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self.cache_control = cache_control
        self.url = f"s3://{bucket}/{self.prefix}"

    def _key(self, key: str) -> str:
        return f"{self.prefix}{key}"

    def write_text(self, key: str, text: str, content_type: str = "application/json") -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=self._key(key),
            Body=text.encode("utf-8"),
            ContentType=content_type,
            CacheControl=self.cache_control,
        )

    def read_text(self, key: str) -> Optional[str]:
        try:
            resp = self.client.get_object(Bucket=self.bucket, Key=self._key(key))
        except self.client.exceptions.NoSuchKey:
            return None
        return resp["Body"].read().decode("utf-8")

    def list_keys(self, prefix: str) -> List[str]:
        keys: List[str] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self._key(prefix)):
            for obj in page.get("Contents", []):
                keys.append(obj["Key"][len(self.prefix):])
        return sorted(keys)


def store_from_url(url: str) -> ResultStore:
    parsed = urlparse(url)
    if parsed.scheme == "s3":
        return S3Store(parsed.netloc, parsed.path.lstrip("/") or "data/")
    if parsed.scheme == "file":
        return LocalFileStore(parsed.path)
    if parsed.scheme == "":
        return LocalFileStore(url)
    raise ValueError(f"unsupported store url: {url}")
