"""The add-on's side of teamree's context-provider protocol: one JSON object per line on stdio."""

import json;
import queue;
import sys;
import threading;
import from typing { Iterator }
import from teamree_jac.graph { as_dict, as_list, as_strings, as_text }
import from teamree_jac.memory { Memory, Job, describe }
import from teamree_jac.history { Mined, mine, apply_history }

glob PROTOCOL: int = 1;

"""Longest request line read; teamree never sends one near this."""
glob MAX_LINE: int = 1048576;

"""What the main loop wakes for: a line from teamree, the end of its input, or history read in the background."""
obj Mail {
    has kind: str;
    has line: str = "";
    has project: str = "";
    has mined: Mined | None = None;
}

def read_lines(inbox: queue.Queue) -> None {
    for line in sys.stdin {
        inbox.put(Mail(kind="line", line=line));
    }
    inbox.put(Mail(kind="eof"));
}

def read_history(memory: Memory, job: Job, inbox: queue.Queue) -> None {
    inbox.put(Mail(kind="mined", project=job.project, mined=memory.read_history(job)));
}

obj Server {
    has memory: Memory;
    has out: any;
    has version: str;
    has inbox: queue.Queue;
    has steps: list[Iterator[int]] = [];

    def send(message: dict) -> None {
        self.out.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n");
        self.out.flush();
    }

    def handle(line: str) -> None {
        if len(line) > MAX_LINE {
            self.send({"type": "error", "message": "line too long"});
            return;
        }
        try {
            message = json.loads(line);
        } except Exception {
            self.send({"type": "error", "message": "not json"});
            return;
        }
        if not isinstance(message, dict) {
            self.send({"type": "error", "message": "not an object"});
            return;
        }
        ident = message.get("id");
        try {
            self.dispatch(message);
        } except Exception as problem {
            reply: dict = {"type": "error", "message": str(problem)[:500] or type(problem).__name__};
            if isinstance(ident, int) {
                reply["id"] = ident;
            }
            self.send(reply);
        }
    }

    def dispatch(message: dict) -> None {
        kind = message.get("type");
        project = str(message.get("projectId", ""));
        if kind == "hello" {
            self.send({"type": "hello", "protocol": PROTOCOL, "name": "jac-memory", "version": self.version});
        } elif kind == "event" {
            job = self.memory.on_event(project, as_dict(message.get("event")));
            if job is not None {
                threading.Thread(target=read_history, args=(self.memory, job, self.inbox), daemon=True).start();
            }
        } elif kind == "context" {
            answer = self.memory.related(project, as_text(message.get("worktreeId")), as_text(message.get("query")));
            self.send({"type": "context", "id": int(message["id"]), "context": {"related": answer["tasks"]}});
        } elif kind == "ask" {
            answer = self.answer(project, as_dict(message.get("ask")));
            self.send({"type": "answer", "id": int(message["id"]), "answer": answer});
        } else {
            raise ValueError(f"unknown request {kind}");
        }
    }

    def answer(project: str, ask: dict) -> dict {
        walker_ = ask.get("walker");
        worktree = as_text(ask.get("worktreeId"));
        if walker_ == "conflict_risk" {
            return self.memory.risk(project, worktree, as_strings(ask.get("paths")), as_list(ask.get("teammates")));
        }
        if walker_ == "why_file" {
            return self.memory.why(project, as_text(ask.get("path")));
        }
        if walker_ == "related_work" {
            return self.memory.related(project, worktree, as_text(ask.get("query")));
        }
        raise ValueError(f"unknown walker {walker_}");
    }

    """Answers lines as they come; between them, puts mined history into the graph a slice at a time."""
    def run() -> None {
        threading.Thread(target=read_lines, args=(self.inbox,), daemon=True).start();
        while True {
            mail: Mail;
            if self.steps {
                try {
                    mail = self.inbox.get_nowait();
                } except queue.Empty {
                    if next(self.steps[0], None) is None {
                        self.steps.pop(0);
                    }
                    continue;
                }
            } else {
                mail = self.inbox.get();
            }
            if mail.kind == "eof" {
                return;
            }
            if mail.kind == "mined" {
                self.steps.append(self.memory.history_steps(mail.project, mail.mined));
            } else {
                self.handle(mail.line);
            }
        }
    }
}

def serve(out: any, data_dir: str, version: str) -> None {
    Server(memory=Memory(data_dir=data_dir), out=out, version=version, inbox=queue.Queue()).run();
}

"""The walkers from a terminal, on one repository and no teamree: `why`, `risk` and `related`."""
def ask_once(command: str, repo: str, base: str, args: list[str]) -> str {
    memory = Memory(data_dir="");
    team = memory.team("cli");
    mined = mine(repo, base, "");
    if mined is None {
        return f"cannot read {base} in {repo}";
    }
    for _ in apply_history(team, mined) {}
    if command == "why" {
        return "\n\n".join([describe(memory.why("cli", path)) for path in args]);
    }
    if command == "risk" {
        return describe(memory.risk("cli", "", args, []));
    }
    return describe(memory.related("cli", "", " ".join(args)));
}
