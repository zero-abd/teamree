"""What the graph remembers: merged work read from git, and teamree's decisions and landings kept in a journal."""

import json;
import os;
import re;
import subprocess;
import from typing { Iterator }
import from teamree_jac.graph { Team, Task, as_int, as_text, as_strings }

"""Commits read from a repository's history; older ones are left out."""
glob HISTORY_COMMITS: int = 3000;

glob GIT_TIMEOUT_S: int = 30;

"""A journal past this size is rewritten from its newest records."""
glob JOURNAL_MAX_BYTES: int = 2000000;

glob JOURNAL_KEEP_LINES: int = 5000;

def git(path: str, args: list[str]) -> str | None {
    env = dict(os.environ);
    env["GIT_OPTIONAL_LOCKS"] = "0";
    env["GIT_TERMINAL_PROMPT"] = "0";
    try {
        done = subprocess.run(
            ["git", "-C", path, "--no-pager", *args],
            capture_output=True, timeout=GIT_TIMEOUT_S, env=env, stdin=subprocess.DEVNULL
        );
    } except Exception {
        return None;
    }
    if done.returncode != 0 {
        return None;
    }
    return done.stdout.decode("utf-8", "replace");
}

"""The first body line that says something: not a trailer, not an issue link."""
def reason_of(body: str) -> str {
    for line in body.split("\n") {
        text = line.strip();
        if not text or re.match(r"^(co-authored-by|signed-off-by|closes|fixes|refs)\b", text.lower()) {
            continue;
        }
        return text;
    }
    return "";
}

"""One commit as `git log` printed it."""
obj Change {
    has sha: str;
    has parents: list[str];
    has author: str;
    has email: str;
    has at: int;
    has subject: str;
    has body: str;
    has files: list[str];
}

"""A landed unit of work: a merged pull request, a squash, or a plain commit on the base."""
obj Landed {
    has key: str;
    has pr: int = 0;
    has branch: str = "";
    has name: str = "";
    has goal: str = "";
    has at: int = 0;
    has commits: list[Change] = [];
}

obj Mined {
    has tip: str;
    has tasks: list[Landed] = [];
}

def parse_log(raw: str) -> dict[str, Change] {
    commits: dict[str, Change] = {};
    for record in raw.split("\x1e") {
        fields = record.split("\x1f");
        if not record.strip() or len(fields) < 8 {
            continue;
        }
        commits[fields[0]] = Change(
            sha=fields[0], parents=fields[1].split(), author=fields[2], email=fields[3], at=int(fields[4] or "0"),
            subject=fields[5], body=fields[6],
            files=[line.strip() for line in fields[7].split("\n") if line.strip()]
        );
    }
    return commits;
}

def landed_from(head: Change) -> Landed {
    found = re.match(r"^Merge pull request #(\d+) from [^/\s]+/(\S+)", head.subject);
    if found {
        branch = found.group(2);
        goal = reason_of(head.body) or branch.replace("-", " ");
        number = int(found.group(1));
        return Landed(key=f"pr:{number}", pr=number, branch=branch, name=branch, goal=goal, at=head.at);
    }
    found = re.match(r"^Merge branch '([^']+)'", head.subject);
    if found {
        branch = found.group(1);
        return Landed(key=f"merge:{head.sha[:12]}", branch=branch, name=branch, goal=head.subject, at=head.at);
    }
    found = re.match(r"^(.*) \(#(\d+)\)$", head.subject);
    if found {
        number = int(found.group(2));
        title = found.group(1);
        return Landed(key=f"pr:{number}", pr=number, name=title, goal=title, at=head.at);
    }
    return Landed(key=f"commit:{head.sha[:12]}", name=head.subject, goal=head.subject, at=head.at);
}

"""Reads `base` from `since` (or from the start when `since` is not behind it) into landed tasks. Plain data, no graph."""
def mine(path: str, base: str, since: str, limit: int = HISTORY_COMMITS) -> Mined | None {
    tip_raw = git(path, ["rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"]);
    if tip_raw is None {
        return None;
    }
    tip = tip_raw.strip();
    if since == tip {
        return Mined(tip=tip);
    }
    moved = since != "" and git(path, ["merge-base", "--is-ancestor", since, tip]) is not None;
    span = f"{since}..{tip}" if moved else tip;
    raw = git(path, [
        "log", "--no-color", "--no-renames", "--name-only", f"-n{limit}",
        "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1f", span
    ]);
    if raw is None {
        return None;
    }
    line_raw = git(path, ["rev-list", "--first-parent", f"-n{limit}", span]) or "";
    if not line_raw {
        return None;
    }
    commits = parse_log(raw);
    mainline = [sha for sha in line_raw.split() if sha in commits];
    on_line = set(mainline);
    taken: set[str] = set();
    mined = Mined(tip=tip);
    for sha in reversed(mainline) {
        head = commits[sha];
        task = landed_from(head);
        if len(head.parents) > 1 {
            # A merge brings in what its other parents reach and the base did not have.
            stack = list(head.parents[1:]);
            while stack {
                current = stack.pop();
                if current in on_line or current in taken or current not in commits {
                    continue;
                }
                taken.add(current);
                task.commits.append(commits[current]);
                stack.extend(commits[current].parents);
            }
        } else {
            task.commits.append(head);
        }
        task.commits.sort(key=lambda c: Change : c.at);
        mined.tasks.append(task);
    }
    return mined;
}

"""Puts mined tasks into the graph, yielding every `chunk` commits so requests are not held up."""
def apply_history(team: Team, mined: Mined, chunk: int = 40) -> Iterator[int] {
    done = 0;
    for row in mined.tasks {
        task = team.task(row.key);
        task.kind = "pr" if row.pr else "commit";
        task.name = task.name or row.name;
        task.branch = task.branch or row.branch;
        task.goal = task.goal or row.goal;
        task.pr = row.pr;
        task.at = max(task.at, row.at);
        if not task.live {
            task.outcome = "merged";
        }
        authors: dict[str, int] = {};
        for commit in row.commits {
            author = team.person(commit.author, commit.email);
            authors[author.name] = authors.get(author.name, 0) + 1;
            team.add_commit(task, commit.sha, commit.subject, reason_of(commit.body), commit.at, author, commit.files);
            done += 1;
            if done % chunk == 0 {
                yield done;
            }
        }
        if authors and task.owner == "me" {
            task.owner = sorted(authors.items(), key=lambda kv: tuple : (-kv[1], kv[0]))[0][0];
        }
        team.mention(task);
    }
    team.tip = mined.tip;
    yield done;
}

"""Append-only NDJSON of what teamree forgets: decisions, and tasks as they landed or were dropped."""
obj Journal {
    has path: str;

    def append(record: dict) -> None {
        os.makedirs(os.path.dirname(self.path), exist_ok=True);
        with open(self.path, "a", encoding="utf-8") as out {
            out.write(json.dumps(record, separators=(",", ":")) + "\n");
        }
    }

    """Every record that still parses; a torn last line is skipped. Rewrites an oversized file from its tail."""
    def read() -> list[dict] {
        if not os.path.exists(self.path) {
            return [];
        }
        with open(self.path, encoding="utf-8", errors="replace") as source {
            lines = source.read().split("\n");
        }
        records: list[dict] = [];
        for line in lines {
            if not line.strip() {
                continue;
            }
            try {
                value = json.loads(line);
            } except Exception {
                continue;
            }
            if isinstance(value, dict) {
                records.append(value);
            }
        }
        if os.path.getsize(self.path) > JOURNAL_MAX_BYTES {
            records = records[-JOURNAL_KEEP_LINES:];
            partial = self.path + ".partial";
            with open(partial, "w", encoding="utf-8") as out {
                for record in records {
                    out.write(json.dumps(record, separators=(",", ":")) + "\n");
                }
            }
            os.replace(partial, self.path);
        }
        return records;
    }
}

"""A task as the journal keeps it: enough to find it again as related work."""
def task_record(task: Task, files: list[str]) -> dict {
    return {
        "t": "task", "key": task.key, "name": task.name, "branch": task.branch, "goal": task.goal,
        "outcome": task.outcome, "at": task.at, "owner": task.owner, "files": files[:200]
    };
}

def replay(team: Team, records: list[dict]) -> None {
    for record in records {
        kind = record.get("t");
        if kind == "note" {
            owner = team.task(as_text(record.get("task")));
            at = as_int(record.get("at"));
            team.decide(owner, as_text(record.get("id")), as_text(record.get("text")), at, as_strings(record.get("paths")));
        } elif kind == "forget" {
            team.forget(as_text(record.get("id")));
        } elif kind == "task" {
            task = team.task(as_text(record.get("key")));
            task.kind = "worktree";
            task.name = as_text(record.get("name"));
            task.branch = as_text(record.get("branch"));
            task.goal = as_text(record.get("goal"));
            task.outcome = as_text(record.get("outcome")) or "landed";
            task.at = as_int(record.get("at"));
            task.owner = as_text(record.get("owner")) or "me";
            task.live = False;
            team.set_touched(task, as_strings(record.get("files")));
            team.mention(task);
        }
    }
}

"""Safe as a file name: a project id is a teamree id, but it is never trusted to be one."""
def journal_name(project: str) -> str {
    return re.sub(r"[^A-Za-z0-9_.-]", "_", project)[:120] + ".ndjson";
}
