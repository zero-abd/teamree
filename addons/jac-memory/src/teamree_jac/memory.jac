"""teamree's side of the graph: its events kept, its questions answered by the walkers."""

import os;
import time;
import from teamree_jac.graph {
    Team, Task, File, Touched, Hop, conflict_risk, why_file, related_work, clip, as_text, as_int, as_dict, as_list,
    as_strings
}
import from typing { Iterator }
import from teamree_jac.history { Journal, Mined, mine, apply_history, replay, task_record, journal_name }

glob MOST_RISKS: int = 10;
glob MOST_WHY_TASKS: int = 5;
glob MOST_RELATED: int = 3;

"""Related work below this score is noise, not a lead."""
glob RELATED_FLOOR: float = 4.0;

def seconds(at: any) -> int {
    value = as_int(at);
    return value // 1000 if value > 100000000000 else value;
}

"""A repository's history to read: from `since`, or from the start."""
obj Job {
    has project: str;
    has path: str;
    has base: str;
    has since: str;
}

"""Every project's graph, fed by teamree's events and the repository's history."""
obj Memory {
    has data_dir: str;
    has teams: dict[str, Team] = {};
    has journals: dict[str, Journal] = {};
    has mining: dict[str, bool] = {};

    def team(project: str) -> Team {
        if project in self.teams {
            return self.teams[project];
        }
        made = Team(project=project);
        self.teams[project] = made;
        journal = Journal(path=os.path.join(self.data_dir, journal_name(project)));
        self.journals[project] = journal;
        replay(made, journal.read());
        return made;
    }

    """Applies one event; returns the history to read when a project first arrives or moves."""
    def on_event(project: str, event: dict) -> Job | None {
        team = self.team(project);
        journal = self.journals[project];
        kind = event.get("type");
        if kind == "project" {
            info = as_dict(event.get("project"));
            path = as_text(info.get("path"));
            base = as_text(info.get("baseRef"));
            changed = path != team.path or base != team.base;
            team.path = path;
            team.base = base;
            if path and base and not self.mining.get(project, False) {
                self.mining[project] = True;
                return Job(project=project, path=path, base=base, since="" if changed else team.tip);
            }
        } elif kind == "worktree" {
            self.worktree(team, as_dict(event.get("worktree")));
        } elif kind == "touch" {
            touch = as_dict(event.get("touch"));
            task = team.task("wt:" + as_text(touch.get("worktreeId")));
            team.set_touched(task, as_strings(touch.get("paths"))[:1000]);
        } elif kind == "note" {
            note = as_dict(event.get("note"));
            if note.get("kind") != "decision" {
                return None;
            }
            owner = "wt:" + as_text(note.get("worktreeId"));
            nid = as_text(note.get("id"));
            text = as_text(note.get("text"));
            at = seconds(note.get("at"));
            paths = as_strings(note.get("paths"));
            known = team.notes.get(nid);
            # teamree replays its notes to each fresh process; one already kept is not kept twice.
            if known is not None and known.text == text {
                return None;
            }
            team.decide(team.task(owner), nid, text, at, paths);
            journal.append({"t": "note", "id": nid, "task": owner, "text": text, "at": at, "paths": paths});
        } elif kind == "noteForgotten" {
            nid = as_text(event.get("noteId"));
            if nid in team.notes {
                team.forget(nid);
                journal.append({"t": "forget", "id": nid});
            }
        } elif kind == "landed" {
            key = "wt:" + as_text(event.get("worktreeId"));
            if key in team.tasks {
                self.close(team, team.tasks[key], "landed");
            }
        } elif kind == "worktreeRemoved" {
            key = "wt:" + as_text(event.get("worktreeId"));
            if key in team.tasks {
                task = team.tasks[key];
                if task.live {
                    self.close(team, task, "abandoned");
                }
            }
        }
        return None;
    }

    def worktree(team: Team, row: dict) -> None {
        task = team.task("wt:" + as_text(row.get("id")));
        task.kind = "worktree";
        task.name = as_text(row.get("name"));
        task.branch = as_text(row.get("branch"));
        task.goal = as_text(row.get("goal"));
        task.owner = as_text(row.get("owner")) or "me";
        task.claims = as_strings(row.get("claims"))[:50];
        state = as_text(row.get("state")) or "ready";
        if state == "landed" {
            if task.live {
                self.close(team, task, "landed");
            }
        } else {
            task.live = state == "ready";
            task.outcome = "live";
            task.at = int(time.time());
        }
        parent = as_text(row.get("parentId"));
        team.set_parent(task, "wt:" + parent if parent else "");
        team.mention(task);
    }

    """A worktree that landed or was dropped with work in it: kept, so later tasks can find it."""
    def close(team: Team, task: Task, outcome: str) -> None {
        files = [f.path for f in [task ->:Touched:->]];
        task.live = False;
        task.outcome = outcome;
        task.at = int(time.time());
        if files or outcome == "landed" {
            self.journals[team.project].append(task_record(task, files));
        }
    }

    def risk(project: str, worktree: str, paths: list[str], teammates: list) -> dict {
        team = self.team(project);
        self.teammates(team, teammates);
        viewer = "wt:" + worktree;
        planned = [p for p in paths if p][:50];
        if not planned and viewer in team.tasks {
            planned = [f.path for f in [team.tasks[viewer] ->:Touched:->]][:50];
        }
        walker_ = conflict_risk(team=team, viewer=viewer, planned=planned);
        for path in planned {
            if path in team.files {
                team.files[path] spawn walker_;
            } else {
                walker_.note_people(team.file(path), Hop(source="", share=1.0));
            }
        }
        walker_.finish(MOST_RISKS);
        return {"walker": "conflict_risk", "rows": walker_.rows, "predicted": walker_.predicted};
    }

    """Teammates' live worktrees, as presence carries them: replaced whole on each ask."""
    def teammates(team: Team, rows: list) -> None {
        seen: set[str] = set();
        for item in rows[:100] {
            row = as_dict(item);
            handle = as_text(row.get("handle"));
            worktree = as_text(row.get("worktreeId"));
            key = "peer:" + handle + ":" + worktree;
            seen.add(key);
            task = team.task(key);
            task.kind = "worktree";
            task.owner = handle;
            task.name = as_text(row.get("name")) or worktree;
            task.live = True;
            task.outcome = "live";
            team.set_touched(task, as_strings(row.get("paths"))[:1000]);
        }
        for (key, task) in team.tasks.items() {
            if key.startswith("peer:") and key not in seen {
                task.live = False;
            }
        }
    }

    def why(project: str, path: str) -> dict {
        team = self.team(project);
        answer: dict = {"walker": "why_file", "path": path, "changes": 0, "tasks": [], "decisions": [], "people": []};
        target = team.files.get(path);
        if target is None {
            target = File(path=path);
        } else {
            answer["changes"] = target.changes;
        }
        walker_ = why_file(team=team);
        target spawn walker_;
        answer["tasks"] = walker_.task_rows()[:MOST_WHY_TASKS];
        answer["decisions"] = sorted(walker_.decisions, key=lambda row: dict : -as_int(row["at"]))[:5];
        people = sorted(walker_.people.items(), key=lambda kv: tuple : (-kv[1], kv[0]));
        answer["people"] = [{"name": name, "commits": count} for (name, count) in people[:3]];
        return answer;
    }

    def related(project: str, worktree: str, query: str) -> dict {
        team = self.team(project);
        viewer = "wt:" + worktree;
        task = team.tasks.get(viewer);
        if task is None {
            task = Task(key=viewer, goal=query);
        }
        walker_ = related_work(team=team, query=query);
        task spawn walker_;
        return {"walker": "related_work", "tasks": walker_.ranked(viewer, MOST_RELATED, RELATED_FLOOR)};
    }

    """Reads history (git only, no graph) so it can run off the main thread."""
    def read_history(job: Job) -> Mined | None {
        return mine(job.path, job.base, job.since);
    }

    def history_steps(project: str, mined: Mined | None) -> Iterator[int] {
        self.mining[project] = False;
        return iter([]) if mined is None else apply_history(self.team(project), mined);
    }
}

"""One line of plain words per answer, for people at a terminal."""
def describe(answer: dict) -> str {
    lines: list[str] = [];
    if answer["walker"] == "why_file" {
        lines.append(f"{answer['path']}: {answer['changes']} commits");
        for item in as_list(answer["tasks"]) {
            task = as_dict(item);
            label = f"#{task['pr']} {task['name']}" if task["pr"] else as_text(task["name"]);
            lines.append(f"  {label}: {task['goal']}");
            for reason in as_strings(task["reasons"]) {
                lines.append(f"    - {reason}");
            }
        }
        for item in as_list(answer["decisions"]) {
            decision = as_dict(item);
            lines.append(f"  decided in {decision['worktree']}: {decision['text']}");
        }
        people = [as_dict(p) for p in as_list(answer["people"])];
        if people {
            lines.append("  by " + ", ".join([f"{p['name']} ({p['commits']})" for p in people]));
        }
    } elif answer["walker"] == "conflict_risk" {
        for item in as_list(answer["rows"]) {
            row = as_dict(item);
            if row["kind"] == "co-change" {
                count = f"{row['together']} of {row['of']} commits";
                lines.append(f"{row['via']} usually changes with {row['path']} ({count}); {row['name']} is changing it.");
            } else {
                lines.append(f"{row['name']} {row['kind']} {row['path']}.");
            }
        }
        for item in as_list(answer["predicted"]) {
            guess = as_dict(item);
            lines.append(f"likely also: {guess['path']} ({guess['together']} of {guess['of']} with {guess['with']})");
        }
    } else {
        for item in as_list(answer["tasks"]) {
            task = as_dict(item);
            label = f"#{task['pr']} {task['name']}" if task["pr"] else as_text(task["name"]);
            lines.append(f"{label} ({task['outcome']}): {clip(as_text(task['goal']), 120)}");
            for note in as_strings(task["decisions"]) {
                lines.append(f"  - {note}");
            }
        }
    }
    return "\n".join(lines) if lines else "Nothing found.";
}
