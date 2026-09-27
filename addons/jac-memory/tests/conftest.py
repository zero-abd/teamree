import os
import subprocess
from pathlib import Path

import pytest

os.environ.setdefault("JAC_TOPOLOGY_INDEX", "0")


def run_git(repo: Path, *args: str, at: int = 1_700_000_000, author: str = "Ada") -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": author,
        "GIT_AUTHOR_EMAIL": f"{author.lower()}@example.com",
        "GIT_COMMITTER_NAME": author,
        "GIT_COMMITTER_EMAIL": f"{author.lower()}@example.com",
        "GIT_AUTHOR_DATE": f"{at} +0000",
        "GIT_COMMITTER_DATE": f"{at} +0000",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    done = subprocess.run(["git", "-C", str(repo), *args], env=env, capture_output=True, text=True, check=True)
    return done.stdout.strip()


class Repo:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.at = 1_700_000_000
        path.mkdir(parents=True)
        run_git(path, "init", "-q", "-b", "main")

    def commit(self, subject: str, files: dict[str, str], author: str = "Ada", body: str = "") -> str:
        for name, text in files.items():
            target = self.path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        self.at += 60
        run_git(self.path, "add", "-A", at=self.at, author=author)
        message = subject if not body else f"{subject}\n\n{body}"
        run_git(self.path, "commit", "-q", "-m", message, at=self.at, author=author)
        return run_git(self.path, "rev-parse", "HEAD")

    def merge_pr(self, number: int, branch: str, title: str, commits: list[tuple[str, dict[str, str]]], author: str) -> None:
        run_git(self.path, "checkout", "-q", "-b", branch)
        for subject, files in commits:
            self.commit(subject, files, author=author)
        run_git(self.path, "checkout", "-q", "main")
        self.at += 60
        message = f"Merge pull request #{number} from someone/{branch}\n\n{title}"
        run_git(self.path, "merge", "-q", "--no-ff", "-m", message, branch, at=self.at, author=author)


@pytest.fixture
def repo(tmp_path: Path) -> Repo:
    """A small history: the API and its database move together; a merged PR rate-limited the API."""
    made = Repo(tmp_path / "repo")
    made.commit("Start", {"src/api.ts": "1", "src/db.ts": "1", "package.json": "1", "README.md": "hi"})
    made.commit("Queries go through one pool", {"src/api.ts": "2", "src/db.ts": "2", "package.json": "2"})
    made.commit("Paging reads the cursor from the index", {"src/api.ts": "3", "src/db.ts": "3", "docs/api.md": "1"})
    made.commit("Colours come from the theme", {"src/ui.ts": "1"}, author="Grace")
    made.merge_pr(
        7,
        "rate-limit-the-api",
        "Rate limit the public API",
        [
            ("The limiter keeps its counters in the database, so every instance agrees", {"src/limiter.ts": "1", "src/db.ts": "4"}),
            ("The API asks the limiter before each handler", {"src/api.ts": "4", "src/limiter.ts": "2"}),
        ],
        author="Linus",
    )
    made.commit("Theme toggles in the header", {"src/ui.ts": "2", "src/header.ts": "1"}, author="Grace")
    return made
