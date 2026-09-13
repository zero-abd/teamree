# teamree

An ADE built for teamwork: run several coding agents at once, each in its own
git worktree, and keep track of all of them in one window.

![Three worktrees in the sidebar, each showing its panes and whether they are working, waiting or failed, beside two split terminals](docs/screenshot.png)

## Status

Single-user and working. Runs from source with `npm run dev`, and packages for
macOS, Windows and Linux — though only macOS and Linux have actually been built
and launched; the Windows installer has never been made. See the known gaps in
`ROADMAP.md`, which are recorded rather than discovered. Team features come
after this works.

## Installing a build

If somebody sent you a link rather than a checkout, the installers are on the
releases page and **[`docs/install.md`](docs/install.md) is the thing to read
first**. Not because installing is hard — it is a drag to Applications, an
installer, or `apt install ./teamree_*.deb` — but because none of it is signed,
and so macOS and Windows will both stop you with a warning the first time. That
document explains what each warning is actually saying, what it is not saying,
and the exact way past it on each platform. Every release carries the checksums
that stand in for the signature.

## What it does

**A worktree per task.** Add a repository, start a worktree from any base ref,
local branch, tag, commit or remote branch. Each one is its own checkout, so
five attempts at the same task never see each other's files.

**Terminals, split however you like.** Arbitrarily nested, resizable panes per
worktree, with a real PTY behind each one.

**Terminals that come back.** Quitting kills every shell — a PTY is a child
process — but a pane running a coding agent comes back with its conversation
resumed, because the agent keeps that on disk and teamree remembers which
session was in which pane. An ordinary pane comes back as a shell in the same
directory, and its command is deliberately never re-run.

**Which agent needs you.** Every pane in every worktree shows what it is doing
— working, waiting, finished, failed — and how long since it last said
anything. That is the question five parallel agents create and the one thing
git status cannot answer. It is deliberately a narrow reading: teamree watches
a PTY, not an agent's protocol, so "waiting" means the output stopped, not that
the agent asked you something.

**All of them at once.** One view lists every pane in every worktree, ordered
by what would make you look: failures first, then work in progress, then
waiting, then finished, and within each the one that has been silent longest.
Counts per state sit above it, and a row takes you to that pane.

**A live picture of the work.** Status per worktree, updated by watching the
checkout rather than by polling, so an edit made by an agent inside a
ten-minute shell session moves the chips immediately. A panel shows the changed
paths and the patch for any of them.

**Enough git to finish.** See what changed, tick what should go in, commit it,
and check whether the branch would merge into its base — answered in memory, so
asking costs the repository nothing. Push when it is ready. There is no force
push and no flag to ask for one.

**Everything the GUI can do, the CLI can do.** `teamree` talks to the running
app over a local socket, so an agent can create a worktree, open a terminal,
run a command and read the output back — and the GUI reflects all of it live,
because both ends meet at the same runtime rather than at a transport.

```sh
teamree worktree create --project app --name "fix login"
teamree worktree wait fix-login
teamree terminal run --worktree fix-login --command "npm test"
teamree worktree changes fix-login
```

**The relay, for when the team is not in one room.** Two machines behind two
routers cannot reach each other, so both dial out to a small relay that splices
their connections together and is never trusted with what crosses it. A team
runs its own, as a Cloudflare Worker or a container — see `relay/README.md`.
`docs/teamwork.md` is the plan the relay is part of.

## Running it

```sh
npm install
npm run dev
```

`npm test` runs the suite, including an acceptance pass that drives a real
runtime over the real socket. `npm run typecheck`, `npm run lint` and
`npm run format:check` are what CI checks, on all three platforms, alongside the
build, the smoke test and the packaged artifact.

## Trying teamwork

`examples/ledger` is a small project that exists to be worked in — no
dependencies, a test suite that runs in a second, and a task list chosen so two
people can take a task each without colliding. `node
examples/init-example-repo.mjs ~/teamree-example` turns it into a real
repository.

**[`docs/trying-teamwork.md`](docs/trying-teamwork.md) is the thing to follow**:
two people on two Macs, start to finish — the relay, both keys committed and
pushed, and each other's worktrees in the sidebar — with a troubleshooting
section for what actually goes wrong. Identity, the roster, the relay and
presence are built; watching a teammate's pane and typing into one are the next
two milestones, and the runbook is exact about which is which.
`docs/teamwork.md` is why it is built this way, and `relay/README.md` is how to
stand a relay up.

## Packaged builds

Packaging is electron-builder, configured in `electron-builder.yml`. Every command
rebuilds the app first, so a package is never made from stale output.

| Platform | Command | Artifacts in `dist/` |
| --- | --- | --- |
| macOS | `npm run package:mac` | `teamree-<version>.dmg`, universal (Apple Silicon and Intel in one file) |
| Windows | `npm run package:win` | `teamree-<version>-setup-x64.exe` (NSIS) |
| Linux | `npm run package:linux` | `teamree-<version>-x86_64.AppImage`, `teamree_<version>_amd64.deb` |
| The one you are on | `npm run package` | as above, for the host platform |

Two more, for working on packaging itself:

- `npm run package:dir` — unpacked app only, no installers. Much faster.
- `npm run package:verify` — launches the packaged app against a throwaway
  profile, drives it through the CLI the app ships, opens a real PTY in it and
  reads the output back. This is the check that matters: `node-pty` needs its
  native binary outside the asar, plus an executable `spawn-helper` on macOS and
  two backends and a ConPTY sidecar on Windows, and only spawning a shell proves
  all of that survived packaging.

On Linux, run both the smoke test and this one under a virtual display:
`xvfb-run --auto-servernum npm run package:verify`. Electron also refuses to
start as root unless the sandbox is switched off; the scripts detect that and
pass `--no-sandbox` themselves, so a container needs no special invocation.

Each platform's artifact must be built on that platform. `node-pty` publishes
prebuilt binaries for macOS and Windows but none for Linux, where `npm install`
compiles one — so a Linux package built anywhere else would contain no working
terminal at all. `.github/workflows/build.yml` runs every check and all three
builds on three runners for that reason, and both `ci.yml` and `release.yml`
call it rather than restating it.

The app icon is generated, not drawn by hand: `npm run icons` rewrites
`build/icon.png`, `build/icon.icns`, `build/icon.ico` and `build/icons/`.

### Signing

Local builds are **unsigned**, and the configuration says so deliberately rather
than half-configuring it. macOS builds are ad-hoc signed, which is the minimum
Apple Silicon needs to launch a binary at all; other machines will still see an
unidentified developer, and Windows will still show SmartScreen.

To produce distributable builds, a maintainer supplies their own credentials —
a Developer ID certificate and an App Store Connect key for macOS, a
code-signing certificate for Windows. The exact environment variables and the
one-line flag change are written down in `electron-builder.yml`, next to the
settings they switch on; `build/entitlements.mac.plist` is already filled in for
a hardened-runtime, notarized build.

Until somebody does that, every download is an unsigned one, and the person on
the other end meets a warning rather than an app.
[`docs/install.md`](docs/install.md) is written for them: what macOS and Windows
each say, what they mean by it, and the way through on each platform.

## The `teamree` CLI from a packaged install

The CLI ships inside the app, at `resources/cli/` next to a launcher per
platform. The launcher runs the bundled CLI under the app's own Electron binary
in plain-Node mode, so an installed app needs no separate Node runtime. It finds
the running app the same way it always does, through the discovery file the
runtime writes, so the CLI and the GUI stay in step.

Putting it on `PATH` is one command per platform, and they live in
[`docs/install.md`](docs/install.md) with the rest of what an installed copy
needs — including the reason a `.deb` install already has a `teamree` on `PATH`
that is the application rather than the CLI.

With the app running:

```
$ teamree status
```

If the app is not running, the CLI says so and exits 3 rather than hanging.

## Releases

`.github/workflows/release.yml` turns a `v*` tag into downloadable installers.
It does not build them itself: it calls `.github/workflows/build.yml`, which is
the same workflow `ci.yml` calls on every pull request, so what gets published
has been through typecheck, lint, format, the full suite, the smoke test and the
packaged-app check on all three platforms. A release pipeline of its own would
be a second, shorter sequence that nobody reads the output of, and the check it
would be tempting to leave out — launching the artifact and spawning a PTY in it
— is the only one that can tell a package that built from a package that works.

The job then attaches every installer to the release along with a
`SHA256SUMS.txt`, and writes notes that say plainly that nothing is signed and
what each platform will do about that. Unsigned software that arrives without
explaining itself gets clicked through or thrown away, and neither is what you
want from somebody trying it for the first time.
