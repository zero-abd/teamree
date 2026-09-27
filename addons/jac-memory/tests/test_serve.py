import json
import os
import subprocess
import sys
import time

import pytest


class Provider:
    """The add-on as teamree runs it: a child process spoken to in NDJSON."""

    def __init__(self, data: str) -> None:
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        self.process = subprocess.Popen(
            [sys.executable, "-m", "teamree_jac", "serve", "--data", data],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        self.next_id = 0

    def send(self, message: dict) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def read(self) -> dict:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        assert line, self.process.stderr.read() if self.process.stderr else "closed"
        return json.loads(line)

    def ask(self, ask: dict) -> tuple[dict, float]:
        self.next_id += 1
        started = time.perf_counter()
        self.send({"type": "ask", "id": self.next_id, "projectId": "p1", "ask": ask})
        reply = self.read()
        assert reply.get("id") == self.next_id, reply
        return reply, time.perf_counter() - started

    def close(self) -> int:
        assert self.process.stdin is not None
        self.process.stdin.close()
        return self.process.wait(timeout=20)


@pytest.fixture
def provider(tmp_path):
    made = Provider(str(tmp_path / "data"))
    yield made
    if made.process.poll() is None:
        made.process.kill()


def test_speaks_only_protocol_on_stdout_and_answers_in_time(provider, repo):
    provider.send({"type": "hello", "protocol": 1, "app": "teamree test"})
    assert provider.read() == {"type": "hello", "protocol": 1, "name": "jac-memory", "version": "0.1.0"}
    provider.send({"type": "event", "projectId": "p1", "event": {"type": "project", "project": {
        "id": "p1", "name": "repo", "path": str(repo.path), "baseRef": "main"}}})
    for wid, name, touched in (("w1", "paging", ["src/api.ts"]), ("w2", "pool-sizes", ["src/db.ts"])):
        provider.send({"type": "event", "projectId": "p1", "event": {"type": "worktree", "worktree": {
            "id": wid, "projectId": "p1", "name": name, "branch": name, "goal": "", "state": "ready", "owner": "me"}}})
        provider.send({"type": "event", "projectId": "p1", "event": {"type": "touch", "touch": {
            "worktreeId": wid, "paths": touched, "source": "diff", "at": 1}}})

    deadline = time.time() + 20
    while True:
        reply, _ = provider.ask({"walker": "why_file", "path": "src/limiter.ts"})
        if reply["answer"]["tasks"] or time.time() > deadline:
            break
        time.sleep(0.1)
    assert reply["type"] == "answer"
    assert reply["answer"]["tasks"][0]["pr"] == 7

    reply, took = provider.ask({"walker": "conflict_risk", "worktreeId": "w1", "paths": ["src/api.ts"]})
    assert [row["name"] for row in reply["answer"]["rows"]] == ["pool-sizes"]
    assert took < 0.8

    provider.send({"type": "context", "id": 99, "projectId": "p1", "worktreeId": "w1", "budgetTokens": 500})
    context = provider.read()
    assert context["type"] == "context" and context["id"] == 99 and "related" in context["context"]
    assert provider.close() == 0


def test_bad_lines_get_an_error_and_the_process_keeps_going(provider):
    provider.send({"type": "hello", "protocol": 1, "app": "t"})
    provider.read()
    provider.process.stdin.write("not json\n")
    provider.process.stdin.flush()
    assert provider.read() == {"type": "error", "message": "not json"}
    reply, _ = provider.ask({"walker": "nope"})
    assert reply == {"type": "error", "id": 1, "message": "unknown walker nope"}
    reply, _ = provider.ask({"walker": "why_file", "path": "nothing.ts"})
    assert reply["answer"]["tasks"] == [] and reply["answer"]["changes"] == 0
    assert provider.close() == 0
