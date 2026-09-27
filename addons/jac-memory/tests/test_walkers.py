import jaclang  # noqa: F401
import pytest

from teamree_jac.history import apply_history, mine
from teamree_jac.memory import Memory, describe


@pytest.fixture
def memory(repo, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    made = Memory(data_dir=str(tmp_path / "data"))
    assert made.on_event("p1", {"type": "project", "project": {"id": "p1", "path": str(repo.path), "baseRef": "main"}})
    mined = mine(str(repo.path), "main", "")
    for _ in apply_history(made.team("p1"), mined):
        pass
    made.mining["p1"] = False
    return made


def worktree(memory, wid, name, goal="", touched=(), claims=(), state="ready", parent=None):
    row = {"id": wid, "projectId": "p1", "name": name, "branch": name, "goal": goal, "state": state, "owner": "me",
           "claims": list(claims)}
    if parent:
        row["parentId"] = parent
    memory.on_event("p1", {"type": "worktree", "worktree": row})
    memory.on_event("p1", {"type": "touch", "touch": {"worktreeId": wid, "paths": list(touched), "source": "diff", "at": 1}})


def test_history_groups_a_merged_pull_request_into_one_task(memory):
    team = memory.team("p1")
    task = team.tasks["pr:7"]
    assert (task.branch, task.pr, task.goal, task.owner) == ("rate-limit-the-api", 7, "Rate limit the public API", "Linus")
    direct = [t for t in team.tasks.values() if t.kind == "commit"]
    assert sorted(t.name for t in direct) == [
        "Colours come from the theme",
        "Paging reads the cursor from the index",
        "Queries go through one pool",
        "Start",
        "Theme toggles in the header",
    ]


def test_a_sibling_on_a_file_that_usually_moves_with_mine_is_a_risk(memory):
    worktree(memory, "w1", "paging", goal="Page the list endpoint", touched=["src/api.ts"])
    worktree(memory, "w2", "pool-sizes", goal="Tune the pool", touched=["src/db.ts"])
    worktree(memory, "w3", "theme", goal="Dark theme", touched=["src/ui.ts"])
    answer = memory.risk("p1", "w1", ["src/api.ts"], [])
    assert answer["rows"] == [
        {"path": "src/db.ts", "kind": "co-change", "worktreeId": "w2", "name": "pool-sizes", "owner": "me",
         "score": 0.75, "via": "src/api.ts", "together": 3, "of": 4},
    ]
    assert answer["predicted"][0] == {"path": "src/db.ts", "with": "src/api.ts", "together": 3, "of": 4}
    assert "src/api.ts usually changes with src/db.ts (3 of 4 commits); pool-sizes is changing it." in describe(answer)


def test_direct_touches_claims_and_teammates_rank_above_co_change(memory):
    worktree(memory, "w1", "paging", touched=["src/api.ts"])
    worktree(memory, "w2", "pool-sizes", touched=["src/db.ts"])
    worktree(memory, "w4", "docs", claims=["src/**"])
    answer = memory.risk("p1", "w1", ["src/api.ts"], [{"handle": "grace", "worktreeId": "g1", "name": "api-auth", "paths": ["src/api.ts"]}])
    kinds = [(row["kind"], row["name"], row["owner"], row["path"]) for row in answer["rows"]]
    assert kinds[:2] == [("touched", "api-auth", "grace", "src/api.ts"), ("claimed", "docs", "me", "src/api.ts")]
    assert ("co-change", "pool-sizes", "me", "src/db.ts") in kinds
    # A teammate who left presence is no longer live.
    again = memory.risk("p1", "w1", ["src/api.ts"], [])
    assert all(row["owner"] == "me" for row in again["rows"])


def test_hot_files_and_weak_pairs_are_not_predicted(memory):
    answer = memory.risk("p1", "", ["src/api.ts"], [])
    paths = [row["path"] for row in answer["predicted"]]
    assert "package.json" not in paths
    assert "docs/api.md" not in paths


def test_why_a_file_names_the_pull_request_its_reasons_and_people(memory):
    answer = memory.why("p1", "src/limiter.ts")
    assert answer["changes"] == 2
    assert [t["key"] for t in answer["tasks"]] == ["pr:7"]
    assert answer["tasks"][0]["reasons"] == [
        "The limiter keeps its counters in the database, so every instance agrees",
        "The API asks the limiter before each handler",
    ]
    assert answer["people"] == [{"name": "Linus", "commits": 2}]


def test_a_decision_outlives_its_landed_worktree_and_a_restart(memory, tmp_path):
    worktree(memory, "w2", "pool-sizes", goal="Tune the pool", touched=["src/db.ts"])
    note = {"id": "n1", "worktreeId": "w2", "kind": "decision", "text": "Pool size comes from env, never from code",
            "scope": "private", "paths": ["src/db.ts"], "at": 1_700_000_900_000, "author": "me"}
    memory.on_event("p1", {"type": "note", "note": note})
    memory.on_event("p1", {"type": "landed", "worktreeId": "w2", "into": "main"})
    memory.on_event("p1", {"type": "worktreeRemoved", "worktreeId": "w2"})
    decided = memory.why("p1", "src/db.ts")["decisions"]
    assert decided == [{"text": "Pool size comes from env, never from code", "at": 1_700_000_900,
                        "worktree": "pool-sizes", "outcome": "landed"}]

    fresh = Memory(data_dir=str(tmp_path / "data"))
    assert fresh.why("p1", "src/db.ts")["decisions"] == decided


def test_a_forgotten_decision_stays_forgotten(memory, tmp_path):
    worktree(memory, "w2", "pool-sizes", touched=["src/db.ts"])
    note = {"id": "n1", "worktreeId": "w2", "kind": "decision", "text": "Globbed", "scope": "private",
            "paths": ["src/**"], "at": 1, "author": "me"}
    memory.on_event("p1", {"type": "note", "note": note})
    assert [d["text"] for d in memory.why("p1", "src/api.ts")["decisions"]] == ["Globbed"]
    memory.on_event("p1", {"type": "noteForgotten", "noteId": "n1"})
    assert memory.why("p1", "src/api.ts")["decisions"] == []
    assert Memory(data_dir=str(tmp_path / "data")).why("p1", "src/api.ts")["decisions"] == []


def test_related_work_finds_the_earlier_task_by_files_and_words(memory):
    worktree(memory, "w1", "limit-the-api-harder", goal="Stricter rate limit on the API", touched=["src/limiter.ts"])
    tasks = memory.related("p1", "w1", "")["tasks"]
    assert [t["key"] for t in tasks] == ["pr:7"]
    assert tasks[0]["files"] == ["src/limiter.ts"]
    assert set(tasks[0]["terms"]) >= {"limit", "api"}
    assert tasks[0]["outcome"] == "merged"


def test_unrelated_work_finds_nothing(memory):
    worktree(memory, "w5", "fonts", goal="Bundle a monospace font", touched=["assets/font.woff2"])
    assert memory.related("p1", "w5", "")["tasks"] == []


def test_an_abandoned_worktree_is_remembered_as_abandoned(memory):
    worktree(memory, "w6", "limiter-in-redis", goal="Move the rate limit counters to redis", touched=["src/limiter.ts"])
    memory.on_event("p1", {"type": "worktreeRemoved", "worktreeId": "w6"})
    worktree(memory, "w7", "limiter-again", goal="Rate limit counters in redis", touched=["src/limiter.ts"])
    tasks = memory.related("p1", "w7", "")["tasks"]
    assert tasks[0]["name"] == "limiter-in-redis"
    assert tasks[0]["outcome"] == "abandoned"
