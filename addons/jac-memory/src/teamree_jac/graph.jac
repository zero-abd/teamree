"""The team work graph: people, tasks, commits, files and decisions, and the walkers that answer from it."""

import math;
import re;
import fnmatch;
import posixpath;

glob HOT_NAMES: list[str] = [
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
    "Cargo.lock", "go.sum", "go.mod", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock",
    "composer.lock", "CHANGELOG.md", "index.ts", "index.js", "index.tsx"
];

glob STOP_WORDS: list[str] = [
    "the", "and", "for", "with", "from", "into", "that", "this", "when", "then", "than", "not", "are",
    "was", "its", "all", "any", "one", "two", "has", "have", "had", "but", "out", "off", "via", "per",
    "use", "add", "fix", "make", "more", "less", "new", "old", "now", "can", "get", "set", "does",
    "merge", "pull", "request", "branch", "main", "master", "zero", "abd", "wip", "own", "every",
    "each", "after", "before", "only", "also", "still", "what", "who", "why", "how", "you", "your"
];

"""Co-change is trusted from this many shared commits and this share of a file's commits."""
glob MIN_TOGETHER: int = 2;
glob MIN_CONFIDENCE: float = 0.25;

"""A commit touching more files than this says little about which files belong together."""
glob MAX_COMMIT_FILES: int = 20;

node Person {
    has name: str;
    has email: str = "";
}

node Task {
    has key: str;
    has name: str = "";
    has branch: str = "";
    has goal: str = "";
    has kind: str = "pr";
    has pr: int = 0;
    has at: int = 0;
    has outcome: str = "merged";
    has owner: str = "me";
    has parent: str = "";
    has claims: list[str] = [];
    has live: bool = False;
}

node Commit {
    has sha: str;
    has subject: str;
    has why: str = "";
    has at: int = 0;
}

node File {
    has path: str;
    has changes: int = 0;
}

node Decision {
    has nid: str;
    has text: str;
    has at: int = 0;
    has globs: list[str] = [];
}

node Term {
    has word: str;
}

edge Authored: Person --> Commit {}
edge Contains: Task --> Commit {}
edge Changed: Commit --> File {}
edge CoChanged: File --> File {
    has together: int = 0;
}
edge Touched: Task --> File {}
edge Decided: Task --> Decision {}
edge About: Decision --> File {}
edge Mentions: Task --> Term {}
edge Child: Task --> Task {}

"""True for lockfiles and other files nearly every change touches."""
def is_hot(path: str) -> bool {
    return posixpath.basename(path) in HOT_NAMES;
}

"""Lower-case words worth matching on: no stop words, no numbers, a plural's s dropped."""
def words_of(text: str) -> list[str] {
    found: list[str] = [];
    for raw in re.findall(r"[a-z0-9]+", text.lower()) {
        word = str(raw);
        if len(word) < 3 or word.isdigit() or word in STOP_WORDS {
            continue;
        }
        if len(word) > 4 and word.endswith("s") and not word.endswith("ss") {
            word = word[:-1];
        }
        if word not in found {
            found.append(word);
        }
    }
    return found;
}

def is_glob(path: str) -> bool {
    return "*" in path or "?" in path or "[" in path;
}

def glob_match(path: str, pattern: str) -> bool {
    if pattern.endswith("/**") {
        return path.startswith(pattern[:-2]) or path == pattern[:-3];
    }
    return fnmatch.fnmatchcase(path, pattern);
}

def matches_any(path: str, patterns: list[str]) -> bool {
    for pattern in patterns {
        if glob_match(path, pattern) {
            return True;
        }
    }
    return False;
}

"""Values from JSON arrive untyped; these give the checker, and the graph, the type they should have."""
def as_text(value: any) -> str {
    return "" if value is None else str(value);
}

def as_int(value: any) -> int {
    try {
        return int(value);
    } except Exception {
        return 0;
    }
}

def as_dict(value: any) -> dict {
    return value if isinstance(value, dict) else {};
}

def as_list(value: any) -> list {
    return value if isinstance(value, list) else [];
}

def as_strings(value: any) -> list[str] {
    if not isinstance(value, list) {
        return [];
    }
    items: list = value;
    return [str(item) for item in items];
}

def rounded(value: float, places: int) -> float {
    scale = 10 ** places;
    return math.floor(value * scale + 0.5) / scale;
}

def clip(text: str, most: int) -> str {
    line = text.strip().split("\n")[0].strip();
    return line if len(line) <= most else line[:most - 1] + "…";
}

def task_id(task: Task) -> str {
    return task.key.split(":", 1)[1] if task.key.startswith("wt:") else task.key;
}

"""One project's graph and the indexes that find its nodes by name."""
obj Team {
    has project: str;
    has path: str = "";
    has base: str = "";
    has tip: str = "";
    has files: dict[str, File] = {};
    has tasks: dict[str, Task] = {};
    has commits: dict[str, Commit] = {};
    has people: dict[str, Person] = {};
    has terms: dict[str, Term] = {};
    has notes: dict[str, Decision] = {};
    has pairs: dict[str, CoChanged] = {};
    has counts: dict[str, int] = {};

    def file(path: str) -> File {
        if path in self.files {
            return self.files[path];
        }
        found = File(path=path);
        self.files[path] = found;
        return found;
    }

    def task(key: str) -> Task {
        if key in self.tasks {
            return self.tasks[key];
        }
        found = Task(key=key);
        self.tasks[key] = found;
        return found;
    }

    def person(name: str, email: str) -> Person {
        who = email.lower() or name;
        if who in self.people {
            return self.people[who];
        }
        found = Person(name=name, email=email);
        self.people[who] = found;
        return found;
    }

    def term(word: str) -> Term {
        if word in self.terms {
            return self.terms[word];
        }
        found = Term(word=word);
        self.terms[word] = found;
        return found;
    }

    """Links a task to the words of its name, branch and goal, once each."""
    def mention(task: Task) -> None {
        had = {t.word for t in [task ->:Mentions:->]};
        for word in words_of(" ".join([task.name, task.branch.replace("-", " "), task.goal])) {
            if word not in had {
                task +>:Mentions:+> self.term(word);
            }
        }
    }

    """A commit with its files; files that moved together gain a co-change edge both ways."""
    def add_commit(task: Task, sha: str, subject: str, why: str, at: int, author: Person, paths: list[str]) -> None {
        if sha in self.commits {
            return;
        }
        commit = Commit(sha=sha, subject=subject, why=why, at=at);
        self.commits[sha] = commit;
        task +>:Contains:+> commit;
        author +>:Authored:+> commit;
        touched: list[File] = [];
        for path in paths {
            node_file = self.file(path);
            node_file.changes += 1;
            commit +>:Changed:+> node_file;
            touched.append(node_file);
        }
        if len(touched) < 2 or len(touched) > MAX_COMMIT_FILES {
            return;
        }
        for a in touched {
            for b in touched {
                if a.path != b.path {
                    self.bump(a, b);
                }
            }
        }
    }

    def bump(a: File, b: File) -> None {
        key = a.path + "\x00" + b.path;
        count = self.counts.get(key, 0) + 1;
        self.counts[key] = count;
        if key in self.pairs {
            self.pairs[key].together = count;
        } elif count >= MIN_TOGETHER {
            a +>:CoChanged(together=count):+> b;
            self.pairs[key] = [edge a ->:CoChanged:-> b][0];
        }
    }

    """Replaces what a task touched with `paths`."""
    def set_touched(task: Task, paths: list[str]) -> None {
        wanted = set(paths);
        for gone in [f for f in [task ->:Touched:->] if f.path not in wanted] {
            for e in [edge task ->:Touched:-> gone] {
                del e;
            }
        }
        have = {f.path for f in [task ->:Touched:->]};
        for path in paths {
            if path not in have {
                task +>:Touched:+> self.file(path);
            }
        }
    }

    def set_parent(task: Task, parent_key: str) -> None {
        for e in [edge task <-:Child:<-] {
            del e;
        }
        task.parent = parent_key;
        if parent_key and parent_key in self.tasks {
            self.tasks[parent_key] +>:Child:+> task;
        }
    }

    """A decision about paths; concrete paths get an edge, globs are matched when read."""
    def decide(task: Task, nid: str, text: str, at: int, paths: list[str]) -> Decision {
        if nid in self.notes {
            self.forget(nid);
        }
        decision = Decision(nid=nid, text=text, at=at, globs=[p for p in paths if is_glob(p)]);
        self.notes[nid] = decision;
        task +>:Decided:+> decision;
        for path in paths {
            if not is_glob(path) {
                decision +>:About:+> self.file(path);
            }
        }
        return decision;
    }

    def forget(nid: str) -> None {
        if nid in self.notes {
            gone = self.notes.pop(nid);
            del gone;
        }
    }

    def live_tasks() -> list[Task] {
        return [t for t in self.tasks.values() if t.live];
    }

    """How many commits changed both, from `a`'s side."""
    def together(a: File, b: File) -> int {
        pair = self.pairs.get(a.path + "\x00" + b.path);
        return pair.together if pair is not None else 0;
    }
}

"""One co-change hop: the planned file it came from, and how often the two changed together."""
obj Hop {
    has source: str;
    has share: float;
    has together: int = 0;
    has of: int = 0;
}

"""A task that changed a file, and the reasons its commits gave."""
obj WhyRow {
    has task: Task;
    has reasons: list[str] = [];
}

"""Who else is on the files a planned edit reaches: touched or claimed directly, or one co-change hop away."""
walker conflict_risk {
    has team: Team;
    has viewer: str;
    has planned: list[str];
    has rows: list[dict] = [];
    has predicted: list[dict] = [];
    has via: dict[str, Hop] = {};

    can at_file with File entry {
        if here.path in self.planned {
            self.note_people(here, Hop(source="", share=1.0));
            for other in [here ->:CoChanged:->] {
                together = self.team.together(here, other);
                share = together / max(here.changes, 1);
                if other.path in self.planned or is_hot(other.path) or share < MIN_CONFIDENCE {
                    continue;
                }
                best = self.via.get(other.path);
                if best is None or share > best.share {
                    self.via[other.path] = Hop(source=here.path, share=share, together=together, of=here.changes);
                }
            }
            visit [here ->:CoChanged:together >= MIN_TOGETHER:->];
        } elif here.path in self.via {
            self.note_people(here, self.via[here.path]);
        }
    }

    def note_people(at_file: File, hop: Hop) -> None {
        kind = "touched" if hop.source == "" else "co-change";
        for task in [at_file <-:Touched:<-] {
            if task.live and task.key != self.viewer {
                self.add_row(task, at_file.path, kind, hop, hop.share);
            }
        }
        for task in self.team.live_tasks() {
            if task.key != self.viewer and matches_any(at_file.path, task.claims) {
                self.add_row(task, at_file.path, "claimed" if hop.source == "" else "co-change", hop, hop.share * 0.9);
            }
        }
    }

    def add_row(task: Task, path: str, kind: str, hop: Hop, score: float) -> None {
        row: dict = {
            "path": path, "kind": kind, "worktreeId": task_id(task), "name": task.name or task.branch,
            "owner": task.owner, "score": rounded(score, 3)
        };
        if hop.source {
            row["via"] = hop.source;
            row["together"] = hop.together;
            row["of"] = hop.of;
        }
        for old in self.rows {
            if old["worktreeId"] == row["worktreeId"] and old["owner"] == row["owner"] and old["path"] == path {
                if old["score"] < row["score"] {
                    old.update(row);
                }
                return;
            }
        }
        self.rows.append(row);
    }

    """Ranked rows, and the files the plan will likely need besides its own."""
    def finish(most: int) -> None {
        weight = {"touched": 3, "claimed": 2, "co-change": 1};
        self.rows.sort(key=lambda r: dict : (-weight[r["kind"]], -r["score"], r["path"]));
        self.rows = self.rows[:most];
        ranked = sorted(self.via.items(), key=lambda kv: tuple : (-kv[1].share, kv[0]));
        self.predicted = [
            {"path": path, "with": hop.source, "together": hop.together, "of": hop.of}
            for (path, hop) in ranked[:5]
        ];
    }
}

"""Why a file is the way it is: the tasks and commits that changed it, the decisions about it, and who."""
walker why_file {
    has team: Team;
    has tasks: dict[str, WhyRow] = {};
    has decisions: list[dict] = [];
    has people: dict[str, int] = {};

    can at_file with File entry {
        for commit in [here <-:Changed:<-] {
            for author in [commit <-:Authored:<-] {
                self.people[author.name] = self.people.get(author.name, 0) + 1;
            }
            for task in [commit <-:Contains:<-] {
                row = self.tasks.get(task.key);
                if row is None {
                    row = WhyRow(task=task);
                    self.tasks[task.key] = row;
                }
                if len(row.reasons) < 2 and commit.subject not in row.reasons {
                    row.reasons.append(clip(commit.subject, 200));
                }
            }
        }
        seen: list[str] = [];
        for decision in [here <-:About:<-] {
            self.add_decision(decision);
            seen.append(decision.nid);
        }
        for decision in self.team.notes.values() {
            if decision.nid not in seen and matches_any(here.path, decision.globs) {
                self.add_decision(decision);
            }
        }
    }

    """Newest first, as the answer carries them."""
    def task_rows() -> list[dict] {
        rows = sorted(self.tasks.values(), key=lambda row: WhyRow : -row.task.at);
        return [
            {
                "key": row.task.key, "name": row.task.name or row.task.branch, "branch": row.task.branch,
                "pr": row.task.pr, "goal": clip(row.task.goal, 200), "at": row.task.at,
                "outcome": row.task.outcome, "reasons": row.reasons
            }
            for row in rows
        ];
    }

    def add_decision(decision: Decision) -> None {
        owners = [t for t in [decision <-:Decided:<-]];
        by = owners[0] if owners else None;
        self.decisions.append({
            "text": clip(decision.text, 300), "at": decision.at,
            "worktree": (by.name or by.branch) if by else "", "outcome": by.outcome if by else ""
        });
    }
}

"""Earlier tasks like this one: the same files changed, or the same words in their names and goals."""
walker related_work {
    has team: Team;
    has query: str = "";
    has scores: dict[str, float] = {};
    has shared_files: dict[str, list[str]] = {};
    has shared_terms: dict[str, list[str]] = {};

    can at_task with Task entry {
        total = max(len(self.team.tasks), 1);
        for f in [here ->:Touched:->] {
            if is_hot(f.path) {
                continue;
            }
            earlier: list[Task] = [];
            for commit in [f <-:Changed:<-] {
                earlier.extend([t for t in [commit <-:Contains:<-]]);
            }
            earlier.extend([t for t in [f <-:Touched:<-] if not t.live]);
            keys = {t.key for t in earlier};
            weight = math.log(1 + total / max(len(keys), 1));
            for key in keys {
                self.credit(key, weight, self.shared_files, f.path);
            }
        }
        words = words_of(" ".join([here.name, here.branch.replace("-", " "), here.goal, self.query]));
        for word in words {
            if word not in self.team.terms {
                continue;
            }
            mentioned = [t for t in [self.team.terms[word] <-:Mentions:<-] if not t.live];
            weight = math.log(1 + total / max(len(mentioned), 1));
            for t in mentioned {
                self.credit(t.key, weight, self.shared_terms, word);
            }
        }
    }

    def credit(key: str, weight: float, into: dict[str, list[str]], what: str) -> None {
        self.scores[key] = self.scores.get(key, 0.0) + weight;
        into.setdefault(key, []);
        if what not in into[key] {
            into[key].append(what);
        }
    }

    """At most `most` tasks with two signals or more and a score over `floor`, strongest first."""
    def ranked(viewer: str, most: int, floor: float) -> list[dict] {
        out: list[dict] = [];
        for (key, score) in sorted(self.scores.items(), key=lambda kv: tuple : (-kv[1], kv[0])) {
            if key == viewer or key not in self.team.tasks {
                continue;
            }
            files = self.shared_files.get(key, []);
            terms = self.shared_terms.get(key, []);
            if len(files) + len(terms) < 2 or score < floor {
                continue;
            }
            task = self.team.tasks[key];
            if task.live {
                continue;
            }
            notes = [clip(d.text, 160) for d in [task ->:Decided:->]];
            if not notes {
                commits = sorted([c for c in [task ->:Contains:->]], key=lambda c: Commit : -c.at);
                notes = [clip(c.subject, 160) for c in commits];
            }
            out.append({
                "key": key, "name": task.name or task.branch, "branch": task.branch, "pr": task.pr,
                "goal": clip(task.goal, 160), "at": task.at, "outcome": task.outcome,
                "score": rounded(score, 2), "files": sorted(files)[:3], "terms": terms[:4], "decisions": notes[:2]
            });
            if len(out) >= most {
                break;
            }
        }
        return out;
    }
}
