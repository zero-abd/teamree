<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-dark.svg">
    <img src="brand/wordmark-light.svg" width="340" alt="teamree">
  </picture>
</h1>

<p align="center">
  <img src="https://img.shields.io/badge/release-coming%20soon-08C" alt="Release coming soon">
  <img src="https://img.shields.io/badge/platform-macOS-08C" alt="macOS">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-08C" alt="MIT licence"></a>
</p>

<p align="center">
  <strong>Run several coding agents at once, each in its own git worktree.</strong><br/>
  One window shows what every one of them is doing, and which one is waiting on you.
</p>

<p align="center">
  <img src="docs/screenshot.png" width="960" alt="Three worktrees in the sidebar, each listing its panes with a status dot, beside two split terminals — one running a coding agent, one showing a finished build">
</p>

---

## What it is

Five agents on one repository overwrite each other's files, and five terminal tabs
will not tell you which one has stopped and is waiting for an answer. teamree gives
each task its own git worktree and its own terminals, and puts the state of all of
them in one place.

It is a desktop application, and it is also a CLI over the same runtime — so an
agent can create a worktree, open a terminal and read the output back, and the
window reflects all of it live.

## Install

**Coming soon.** Packaged macOS builds are not published yet. Until then, run it
from source:

```sh
npm install
npm run dev
```

macOS is the only platform teamree targets. That is a decision rather than a gap
waiting to close; [`ROADMAP.md`](ROADMAP.md) has the reasoning.

## Quick start

1. **Add a repository** — a git checkout you already have.
2. **Start a worktree** from any base ref. It is a real checkout of its own, so
   parallel attempts at the same task never see each other's files.
3. **Open terminals in it**, split them, and start an agent in one.
4. **Watch the sidebar** — every pane says whether it is working, waiting, finished
   or failed, and how long since it last said anything.
5. **Review and commit** from the app, and push when it is ready.

## What it does

- **A worktree per task**, created from any base ref.
- **Split terminals** per worktree, arbitrarily nested, with a real PTY behind each.
- **Panes that come back.** A pane running a coding agent returns with its
  conversation resumed; an ordinary pane returns as a shell in the same directory,
  and its command is deliberately never re-run.
- **Which agent needs you.** One view ranks every pane in every worktree by what
  would make you look — failures, then work in progress, then waiting, then
  finished. It is a narrow reading on purpose: teamree watches a PTY, not an
  agent's protocol, so *waiting* means the output stopped, not that you were asked
  something.
- **A live picture of the work**, driven by watching the checkout rather than
  polling, with the changed paths and the patch for any of them.
- **Enough git to finish** — stage, commit, check the branch would merge into its
  base, push. There is no force push and no flag to ask for one.
- **Your own colours.** Four presets ship and all forty-two colours are editable
  (**⌘,**); a palette you build by hand goes through the same legibility pass a
  shipped one does.

## From a shell

`teamree` talks to the running app over a local socket. Every command takes
`--json` and emits exactly one JSON document on stdout, with exit codes that mean
something: `0` success, `1` the command failed, `2` you typed it wrong, `3` nothing
is running to talk to.

```sh
teamree worktree create --project app --name "fix login"
teamree worktree wait fix-login
teamree terminal run --worktree fix-login --command "npm test"
teamree worktree changes fix-login
```

That is the surface a coding agent needs, and it is the same runtime the window
draws, so the two stay in step. The socket is owner-only.
[Who on this machine can drive teamree](docs/local-access.md) is that boundary
written down.

## Working with other people

Two people on two Macs can see each other's worktrees in one sidebar, read what a
teammate's pane is doing, and — with that teammate's say-so — answer a prompt in
it. Identity is the git remote: a teammate is somebody whose key is committed to
the repository.

Machines behind two routers cannot reach each other, so both dial out to a small
relay that splices their connections and is never trusted with what crosses it. A
team runs its own, as a Cloudflare Worker. There is no default relay and nobody
hosts one for you.

Be clear about what this is: a teammate whose key is in the repository can run
commands as you — once you let them. Their keystrokes are held on your machine
until you have been shown who is asking, which pane, and the bytes themselves, and
have answered. The prompt is for accidents, which is what nearly every bad
keystroke is. It is not a wall against somebody you should not have added.

## Documentation

[`docs/`](docs/) is indexed in [`docs/README.md`](docs/README.md).

- [Trying teamwork](docs/trying-teamwork.md) — two people, two Macs, start to finish
- [Teamwork](docs/teamwork.md) — why it is built this way
- [The relay](relay/README.md) — standing one up, and what it can and cannot see
- [Installing teamree](docs/install.md) — for when there is a build to install
- [Packaging](docs/packaging.md) and [releasing](docs/releasing.md) — for maintainers
- [Roadmap](ROADMAP.md) — what is done, and the known gaps

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup and the checks:

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
```

## Licence

MIT. See [`LICENSE`](LICENSE).
