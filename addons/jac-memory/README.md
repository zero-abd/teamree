# teamree-jac

teamree's **Jac Graph Memory** add-on: a team work graph written in [Jac](https://jac-lang.org) (object-spatial programming), run beside teamree as a separate process. It answers questions that teamree's flat coordination ledger cannot:

| Walker | Question | Where teamree shows it |
|---|---|---|
| `conflict_risk` | Who else is on the files I'm about to edit, **or on files that usually change with them**? | The edit-time hook an agent hears before `Edit`/`Write`; `teamree risk`; MCP `conflict_risk` |
| `why_file` | Why is this file like this: which merged tasks changed it, the reasons their commits gave, decisions recorded on it (kept after their worktree landed), who changed it most | `teamree why <path>`; MCP `why_file` |
| `related_work` | Which earlier tasks touched the same files or used the same words, how they ended, and what they decided | The session-start bundle, within its token budget |

Everything is deterministic: no LLM calls, no network. History comes from `git log` on the project's base branch; teamree's own decisions, landings and abandoned worktrees are kept in a small journal, because the ledger forgets them when a worktree lands.

## The graph

```
Person -Authored-> Commit -Changed-> File -CoChanged{together}-> File
Task -Contains-> Commit        Task -Touched-> File        Task -Child-> Task
Task -Decided-> Decision -About-> File                     Task -Mentions-> Term
```

A `Task` is a merged pull request, a plain commit on the base, a live teamree worktree, or one that landed or was dropped. `CoChanged` edges come from commits of at most 20 files that changed both files at least twice; lockfiles and other files every change touches are never predicted. The walkers are in `src/teamree_jac/graph.jac`.

## Install

teamree installs it for you: **Settings › Add-ons › Jac Graph Memory › Install**. That runs your own [uv](https://docs.astral.sh/uv/) to make a private virtual environment under teamree's user data folder (`addons/jac`) with a pinned release, then turns it on. teamree never downloads uv or anything else by itself; without uv the row says **Needs uv**. It needs Python 3.12 or newer, which uv provides.

Try the walkers on any repository without teamree:

```sh
uvx --from "git+https://github.com/zero-abd/teamree@main#subdirectory=addons/jac-memory" teamree-jac why src/app.ts
uvx --from "git+https://github.com/zero-abd/teamree@main#subdirectory=addons/jac-memory" teamree-jac risk src/app.ts
uvx --from "git+https://github.com/zero-abd/teamree@main#subdirectory=addons/jac-memory" teamree-jac related "rate limit the api"
```

Once released to PyPI: `uvx teamree-jac why src/app.ts` (or `pipx run teamree-jac …`).

## How teamree talks to it

`teamree-jac serve --data <dir>` speaks teamree's context-provider protocol: one JSON object per line on stdin/stdout (`src/shared/contextProvider.ts` in the app). teamree sends `hello`, then every ledger change as an `event` (projects, worktrees, touched paths, notes, landings), and asks `context` or `ask` (a walker) with an id. Every call is cut at 800 ms; three failures in a row turn the add-on off until it is turned on again, and teamree answers from its built-in ledger in the meantime. Nothing in the app imports this package, and no Jac or Python ships with teamree.

stdout carries only protocol lines: anything Jac or a library prints goes to stderr.

## Develop

```sh
cd addons/jac-memory
uv run --python 3.12 --extra test pytest -q
uv run --python 3.12 jac check src/teamree_jac/graph.jac src/teamree_jac/history.jac src/teamree_jac/memory.jac src/teamree_jac/serve.jac
```

To run a local checkout inside teamree, start teamree with `TEAMREE_JAC_ADDON_SPEC=/path/to/addons/jac-memory` and press Install.

## Release

Pushing a tag `jac-addon-v<version>` (matching `version` in `pyproject.toml`) runs `.github/workflows/jac-addon.yml`: tests, build, and publish to PyPI through Trusted Publishing (OIDC, no stored token). teamree installs `teamree-jac==<version>` from PyPI, or the tagged source when PyPI does not have it.
