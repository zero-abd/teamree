<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-dark.svg">
    <img src="brand/wordmark-light.svg" width="340" alt="teamree">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/zero-abd/teamree/releases/latest"><img src="https://img.shields.io/github/v/release/zero-abd/teamree?color=08C&label=release" alt="Latest release"></a>
  <a href="https://github.com/zero-abd/teamree/releases"><img src="https://img.shields.io/github/downloads/zero-abd/teamree/total?color=08C&label=downloads" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platform-macOS-08C" alt="macOS">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-08C" alt="MIT licence"></a>
</p>

<p align="center">
  <strong>Run several coding agents at once, each in its own git worktree.</strong><br/>
  One window shows you what every one of them is doing, and which one is waiting on you.
</p>

<h3 align="center"><a href="https://github.com/zero-abd/teamree/releases/latest/download/teamree-mac-universal.dmg"><ins>Download for macOS</ins></a></h3>

<p align="center">
  <img src="docs/screenshot.png" width="960" alt="Three worktrees in the sidebar, each listing its panes with a status dot, beside two split terminals — one running a coding agent, one showing a finished build">
</p>

---

## What it is

Five agents working on the same repository will overwrite each other's files, and
five terminal tabs will not tell you which one has stopped and is waiting for an
answer. teamree gives each task its own git worktree and its own terminals, and
puts the state of all of them in one place.

It is a desktop application, and it is also a CLI over the same runtime — so an
agent can create a worktree, open a terminal and read the output back, and the
window reflects all of it live.

## Install

[**Download the `.dmg`**](https://github.com/zero-abd/teamree/releases/latest/download/teamree-mac-universal.dmg),
open it, and drag teamree to Applications. One universal build: Apple Silicon and
Intel both, nothing to choose between. No GitHub account needed. Check it first
against the `SHA256SUMS.txt` on the [release](https://github.com/zero-abd/teamree/releases/latest):

```sh
shasum -a 256 ~/Downloads/teamree-mac-universal.dmg
```

**Read this before you open it.** The build is ad-hoc signed but has no Apple
Developer certificate behind it, so macOS refuses the first launch with a dialog
headed **"teamree" Not Opened** — *Apple could not verify "teamree" is free of
malware that may harm your Mac or compromise your privacy.* Its two buttons are
**Move to Trash** and **Done**. **Press Done.** Nothing has been found wrong with
teamree: macOS is saying the file arrived without a certificate naming who built
it, not that it examined the app. There is no "Open Anyway" button on that dialog
on current macOS. Clear the quarantine flag once instead:

```sh
xattr -dr com.apple.quarantine /Applications/teamree.app
```

Open it normally after that and it will not ask again.

[`docs/install.md`](docs/install.md) is the long version, walked through against
the published file by somebody who had not installed it before: what the warning
means, the route through System Settings if you would rather not type a command,
how to put the `teamree` CLI on your PATH, and how to uninstall.

macOS is the only platform with a published build. On Windows and Linux, run it
from source — it is the same application.

## From source

```sh
npm install
npm run dev
```

## Quick start

1. **Add a repository.** teamree works against a git checkout you already have.
2. **Start a worktree** from any base ref — a local branch, a tag, a commit, a
   remote branch. It is a real checkout of its own, so parallel attempts at the
   same task never see each other's files.
3. **Open terminals in it**, split however you like, and start an agent in one.
4. **Watch the sidebar.** Every pane shows whether it is working, waiting,
   finished or failed, and how long since it last said anything.
5. **Review and commit** from the app: see what changed, pick what goes in, check
   the branch would merge into its base, push.

## What it does

**A worktree per task.** Each one is its own checkout, created from any base ref.

**Terminals, split however you like.** Arbitrarily nested, resizable panes per
worktree, with a real PTY behind each.

**Terminals that come back.** Quitting kills every shell — a PTY is a child
process — but a pane running a coding agent comes back with its conversation
resumed, because the agent keeps that on disk and teamree remembers which session
was in which pane. An ordinary pane comes back as a shell in the same directory,
and its command is deliberately never re-run.

**Which agent needs you.** One view lists every pane in every worktree, ordered by
what would make you look: failures first, then work in progress, then waiting,
then finished, and within each the one that has been silent longest. It is
deliberately a narrow reading — teamree watches a PTY, not an agent's protocol, so
"waiting" means the output stopped, not that the agent asked you something.

**A live picture of the work.** Status per worktree, updated by watching the
checkout rather than by polling, so an edit made inside a ten-minute shell session
moves the chips immediately. A panel shows the changed paths and the patch for any
of them.

**Enough git to finish.** See what changed, tick what should go in, commit it, and
check whether the branch would merge into its base. Push when it is ready. There
is no force push and no flag to ask for one.

## Everything, from a shell

`teamree` talks to the running app over a local socket. Every command takes
`--json` and emits exactly one JSON document on stdout, with errors on stderr and
exit codes that mean something: `0` success, `1` the command failed, `2` you typed
it wrong, `3` nothing is running to talk to.

```sh
teamree worktree create --project app --name "fix login"
teamree worktree wait fix-login
teamree terminal run --worktree fix-login --command "npm test"
teamree worktree changes fix-login
```

That is the surface a coding agent needs, and it is the same runtime the window
draws, so both stay in step.

## Working with other people

Two people on two Macs can see each other's worktrees in the same sidebar, read
what a teammate's pane is doing, and — with that teammate's say-so — answer a
prompt in it. Identity is the git
remote: a teammate is somebody whose key is committed to the repository.

Machines behind two routers cannot reach each other, so both dial out to a small
relay that splices their connections together and is never trusted with what
crosses it. A team runs its own, as a Cloudflare Worker, and the installed app
carries it — so standing one up needs no clone of this repository. There is no
default relay and nobody hosts one for you.

Be clear about what this is: a teammate whose key is in the repository can run
commands as you — once you let them. Their keystrokes are held on your machine
until you have been shown who is asking, which pane, and the bytes themselves,
and have answered: allow once, allow for this session, allow them in that pane
from now on, or refuse. Anything nobody answers expires, and they are told that
it did. Around that sit the older safeguards, which have not gone anywhere: you
can see who is reading and typing in your panes, there is a durable log of every
remote keystroke your machine decided about, and muting a pane is immediate and
answers the question before it is asked.

The prompt is for accidents, which is what nearly every bad keystroke is. It is
not a wall against somebody you should not have added: once you allow them they
can run anything.

All of it has been driven end to end, but between two runtimes on one machine.
Two Macs in two places is the thing nobody has tried yet.
[`docs/trying-teamwork.md`](docs/trying-teamwork.md) walks two people through it
start to finish, and says which step is which.

## Documentation

[`docs/`](docs/) is indexed in [`docs/README.md`](docs/README.md). The short of it:

- [Installing teamree](docs/install.md) — the download, the warnings, the CLI on PATH
- [Trying teamwork](docs/trying-teamwork.md) — two people, two Macs, start to finish
- [Teamwork](docs/teamwork.md) — why it is built this way
- [The relay](relay/README.md) — standing one up, and what it can and cannot see
- [Packaging](docs/packaging.md) and [releasing](docs/releasing.md) — for maintainers
- [Roadmap](ROADMAP.md) — what is done, and the known gaps

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup and the checks. The short
version is `npm install`, then `npm run typecheck && npm run lint && npm run format:check && npm test`.

## Licence

MIT. See [`LICENSE`](LICENSE).
