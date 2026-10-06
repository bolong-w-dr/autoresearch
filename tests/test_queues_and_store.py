import json
from collections import deque

import pytest

from autoresearch_service.queues import LocalDirQueue, RedisQueue, SqsQueue, queue_from_url
from autoresearch_service.records import MissionRecord, ServiceStatus
from autoresearch_service.schema import example_mission, utcnow
from autoresearch_service.store import LocalFileStore, S3Store, store_from_url


# -- local directory queue --------------------------------------------------

def test_local_queue_roundtrip(tmp_path):
    q = LocalDirQueue(tmp_path / "q")
    q.send({"command": "ping", "n": 1})
    q.send({"command": "ping", "n": 2})
    msgs = q.receive(max_messages=10, wait_seconds=0)
    assert [m.body["n"] for m in msgs] == [1, 2]
    assert q.receive(wait_seconds=0) == []  # in flight, not visible
    q.nack(msgs[0])
    q.ack(msgs[1])
    again = q.receive(wait_seconds=0)
    assert [m.body["n"] for m in again] == [1]
    q.ack(again[0])
    assert q.receive(wait_seconds=0) == []


def test_local_queue_moves_garbage_to_failed(tmp_path):
    q = LocalDirQueue(tmp_path / "q")
    (q.new / "bad.json").write_text("not json")
    assert q.receive(wait_seconds=0) == []
    assert (q.failed / "bad.json").exists()


def test_local_queue_unwraps_sns_envelope(tmp_path):
    q = LocalDirQueue(tmp_path / "q")
    (q.new / "sns.json").write_text(json.dumps({"Type": "Notification", "Message": json.dumps({"command": "ping"})}))
    msgs = q.receive(wait_seconds=0)
    assert msgs[0].body == {"command": "ping"}


# -- SQS with a fake client ---------------------------------------------------

class FakeSqs:
    def __init__(self):
        self.messages = deque()
        self.deleted = []
        self.visibility = []
        self.sent = []

    def send_message(self, **kwargs):
        self.sent.append(kwargs)
        self.messages.append({"MessageId": f"m{len(self.sent)}", "ReceiptHandle": f"r{len(self.sent)}", "Body": kwargs["MessageBody"]})
        return {"MessageId": f"m{len(self.sent)}"}

    def receive_message(self, **kwargs):
        out = []
        while self.messages and len(out) < kwargs["MaxNumberOfMessages"]:
            out.append(self.messages.popleft())
        return {"Messages": out}

    def delete_message(self, **kwargs):
        self.deleted.append(kwargs["ReceiptHandle"])

    def change_message_visibility(self, **kwargs):
        self.visibility.append((kwargs["ReceiptHandle"], kwargs["VisibilityTimeout"]))


def test_sqs_queue_with_fake_client():
    url = "https://sqs.eu-west-1.amazonaws.com/123456789012/autoresearch-commands"
    assert SqsQueue._region_from_url(url) == "eu-west-1"
    client = FakeSqs()
    q = SqsQueue(url, client=client)
    q.send({"command": "ping", "request_id": "req_1"})
    client.messages.append({"MessageId": "bad", "ReceiptHandle": "rbad", "Body": "{{"})
    msgs = q.receive(wait_seconds=0)
    assert len(msgs) == 1 and msgs[0].body["command"] == "ping"
    assert "rbad" in client.deleted  # poison message removed
    q.nack(msgs[0])
    assert client.visibility == [("r1", 0)]
    q.ack(msgs[0])
    assert "r1" in client.deleted


def test_sqs_fifo_sets_group_and_dedup():
    client = FakeSqs()
    q = SqsQueue("https://sqs.us-east-1.amazonaws.com/1/q.fifo", client=client)
    q.send({"command": "ping", "request_id": "req_abc"})
    assert client.sent[0]["MessageGroupId"] == "autoresearch"
    assert client.sent[0]["MessageDeduplicationId"] == "req_abc"


# -- Redis with a fake client -------------------------------------------------

class FakeRedis:
    def __init__(self):
        self.lists = {}

    def rpush(self, key, value):
        self.lists.setdefault(key, []).append(value.encode() if isinstance(value, str) else value)

    def lpush(self, key, value):
        self.lists.setdefault(key, []).insert(0, value.encode() if isinstance(value, str) else value)

    def _move(self, src, dst):
        if not self.lists.get(src):
            return None
        v = self.lists[src].pop(0)
        self.lists.setdefault(dst, []).append(v)
        return v

    def blmove(self, src, dst, timeout, wherefrom, whereto):
        return self._move(src, dst)

    def lmove(self, src, dst, wherefrom, whereto):
        return self._move(src, dst)

    def lrem(self, key, count, value):
        v = value.encode() if isinstance(value, str) else value
        if v in self.lists.get(key, []):
            self.lists[key].remove(v)

    def pipeline(self):
        outer = self

        class P:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def lrem(self, *a):
                outer.lrem(*a)

            def lpush(self, *a):
                outer.lpush(*a)

            def execute(self):
                pass

        return P()


def test_redis_queue_with_fake_client():
    client = FakeRedis()
    q = RedisQueue("redis://localhost/0", client=client, key="k")
    q.send({"command": "ping", "n": 1})
    q.send({"command": "ping", "n": 2})
    msgs = q.receive(max_messages=10, wait_seconds=1)
    assert [m.body["n"] for m in msgs] == [1, 2]
    assert len(client.lists["k:processing"]) == 2
    q.nack(msgs[0])
    q.ack(msgs[1])
    assert len(client.lists["k:processing"]) == 0
    assert [m.body["n"] for m in q.receive(wait_seconds=1)] == [1]


def test_queue_factory(tmp_path):
    assert isinstance(queue_from_url(str(tmp_path / "q")), LocalDirQueue)
    assert isinstance(queue_from_url((tmp_path / "q2").as_uri()), LocalDirQueue)
    with pytest.raises(ValueError):
        queue_from_url("ftp://nope")


# -- stores -------------------------------------------------------------------

def test_local_store_roundtrip(tmp_path):
    store = LocalFileStore(tmp_path / "data")
    record = MissionRecord(mission=example_mission())
    record.log("hello")
    store.save_mission(record)
    loaded = store.load_mission(record.mission.mission_id)
    assert loaded is not None and loaded.events[0].message == "hello"
    assert store.load_mission("missing") is None
    assert [r.mission.mission_id for r in store.load_all_missions()] == [record.mission.mission_id]

    status = ServiceStatus(service_id="svc", host="h", version="0", started_at=utcnow(), queue="q", store="s")
    store.save_index(status, [record])
    index = json.loads(store.read_text("index.json"))
    assert index["service"]["service_id"] == "svc"
    assert index["missions"][0]["mission_id"] == record.mission.mission_id

    store.publish_schemas()
    assert json.loads(store.read_text("schema/mission.schema.json"))["title"] == "AutoresearchMission"
    assert isinstance(store_from_url(str(tmp_path / "other")), LocalFileStore)


class FakeS3:
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, **kw):
        self.objects[Key] = Body

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey()
        import io

        return {"Body": io.BytesIO(self.objects[Key])}

    def get_paginator(self, name):
        objects = self.objects

        class P:
            def paginate(self, Bucket, Prefix):
                yield {"Contents": [{"Key": k} for k in objects if k.startswith(Prefix)]}

        return P()


def test_s3_store_with_fake_client():
    client = FakeS3()
    store = S3Store("bucket", "data", client=client)
    assert store.url == "s3://bucket/data/"
    record = MissionRecord(mission=example_mission())
    store.save_mission(record)
    assert "data/missions/msn_example00001.json" in client.objects
    assert store.load_mission("msn_example00001").mission.name == record.mission.name
    assert store.list_keys("missions/") == ["missions/msn_example00001.json"]
    assert store.read_text("nope") is None
