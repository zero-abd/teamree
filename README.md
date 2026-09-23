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

Download the latest disk image — a universal build, Apple Silicon and Intel
both, and no GitHub account needed:

**<https://github.com/zero-abd/teamree/releases/latest/download/teamree-mac-universal.dmg>**

Nothing in it is signed, so the first time you open it macOS will refuse with a
dialog whose prominent button deletes the download. **Do not press Move to
Trash**; press **Done**, and read
[`docs/install.md`](docs/install.md) — it is four paragraphs and it is the
difference between an app that opens and an app you throw away.

To run it from source instead:

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
- **Several attempts at one task.** The composer takes a count per agent — two
  models against each other, or two runs of one — and starts a worktree each from
  the same ref, named for the agent that runs in it. `--agent`, repeated, does
  the same from a shell.
- **Split terminals** per worktree, arbitrarily nested, with a real PTY behind each.
- **Panes that come back.** A pane running a coding agent returns with its
  conversation resumed — if the agent wrote one. Whether it did is read from that
  agent's own store rather than guessed at from whether anybody typed: a brand-new
  worktree means a trust prompt on the first launch, and answering one is a
  keystroke, not a conversation. A pane with nothing to resume gets a fresh agent
  above what it printed last time, with one line saying why, and a resume that is
  refused anyway says so in the pane and starts a fresh agent there rather than
  dying quietly. teamree only reads those stores; it never writes to them, and it
  answers no other tool's prompts for you. An ordinary pane returns as a shell in
  the same directory, and its command is deliberately never re-run.
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

Setting that up is two commands and one line of text, from either machine or from
an agent working in a pane on it:

```sh
teamree team invite app          # prints one line to send a teammate
teamree team accept "<that line>"  # on their Mac: clone, configure, join, push
```

The line is not a credential and it grants nothing. It carries four facts that
are public already — where the repository is, where the relay is, what the project
is called and who is asking — because those are what a joiner otherwise has to be
told in prose. `accept` ends in a push, and a machine that may not push to that
repository is refused there, in git's own words: membership is push access, and
nothing in a link can hand it over. A finished `accept` says a key was pushed; it
does not say a teammate is connected, because that is a fact about somebody else's
machine. `teamree team status app` is where that is answered.

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
