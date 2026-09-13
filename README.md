# teamree

An ADE built for teamwork: run several coding agents at once, each in its own
git worktree, and keep track of all of them in one window.

![Three worktrees in the sidebar, each showing its panes and whether they are working, waiting or failed, beside two split terminals](docs/screenshot.png)

## Status

Single-user work is done, and teamwork is built rather than planned: all five
milestones have landed, the relay in `relay/` ships with the repository, and
`docs/trying-teamwork.md` walks two people through it — including the one thing
still untested, which is two Macs in two places.

Releases are macOS only: one unsigned universal `.dmg`. CI has packaged it,
launched it and opened a real terminal inside it. Nothing has been published —
no tag has been pushed and `release.yml` has never run. The Linux packaging has
been built and launched; the Windows packaging never has, and `npm run
package:win` cannot succeed as configured (see "Packaged builds"). The known
gaps are in `ROADMAP.md`, recorded rather than discovered.

## Installing a build

If somebody sent you a link rather than a checkout, the download is on the
releases page — one universal macOS `.dmg` — and
**[`docs/install.md`](docs/install.md) is the thing to read first**. Not because
installing is hard; it is a drag to Applications. It is because the build is not
signed, so macOS will stop you with a warning the first time. That document
explains what the warning is actually saying, what it is not saying, and the
exact way past it. Every release carries the checksums that stand in for the
signature.

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

**Everything, from a shell.** `teamree` talks to the running app over a local
socket, so an agent can create a worktree, open a terminal, run a command and
read the output back — and the GUI reflects all of it live, because both ends
meet at the same runtime rather than at a transport. Every command takes
`--json` and emits exactly one JSON document on stdout, with errors on stderr
and exit codes that mean something: 0 success, 1 the command failed, 2 you typed
it wrong, 3 nothing is running to talk to.

```sh
teamree worktree create --project app --name "fix login"
teamree worktree wait fix-login
teamree terminal run --worktree fix-login --command "npm test"
teamree worktree changes fix-login
```

**Teamwork too.** It used to be the window's alone, which made a feature about
working with somebody unusable by the agent working beside you. The `team` group
closes that: an agent can see the roster, tell whether teamwork is actually
connected, read what a teammate's pane is doing, and answer a prompt in it.

```sh
teamree team status app            # on? who is connected? which relay?
teamree team members app           # the roster, as the repository records it
teamree team join app              # write this machine's key into it
teamree team relay set app wss://relay.example/v1/relay
teamree team panes app             # the pane ids the next two commands take
teamree team watch app ana --json  # a bounded snapshot of ana's pane
teamree team watch app ana --follow
teamree team type app ana --text y --enter
teamree team watchers app          # who is reading and typing here
teamree team mute t_12             # and how to stop them
teamree team write-log             # the record of every remote keystroke
teamree worktree start-points app  # everything a new worktree could branch from
teamree worktree layout fix-login  # where the panes are and which has focus
```

`team watch` is a bounded snapshot by default, because a command that never
returns is not one a script can call: it opens the pane, lets the scrollback
land, and stops when the pane has been quiet for a moment. `--follow` streams
until you interrupt it, until the pane's process exits, or until the link goes
away. `--follow` and `--json` are refused together, because `--json` promises
exactly one document and a stream is not one.

`team type` is here for the same reason the rest is: withholding it from the CLI
would not remove the capability from the product, only from the caller whose
commands can be read back. Every guard that makes it survivable is at the
owner's end and is unchanged by the caller being a script — their machine
refuses unless your key is on the roster, refuses outright when they have muted
the pane, caps one write, and records who typed how much into which pane in a
log that survives a restart.

**Three things are still the window's alone**, and none of them is a capability
an agent lacks:

- **Rearranging panes** (`layout.set`). There is no honest way to type a pane
  tree with split ratios at a shell prompt, and getting one wrong scrambles
  somebody's window. The arrangement changes through operations that mean
  something — `terminal split`, `terminal close` — and `worktree layout` reads
  it back.
- **Resizing a pty** (`terminal.resize`). A size is a property of the thing
  drawing the pane; a CLI is not drawing one. `terminal create --cols --rows`
  sets it where it can be known.
- **Dismissing the first-run offer to put `teamree` on your PATH**
  (`cli.dismissPrompt`). It records an answer to a question only the window
  asks.

**The relay, for when the team is not in one room.** Two machines behind two
routers cannot reach each other, so both dial out to a small relay that splices
their connections together and is never trusted with what crosses it. A team
runs its own, as a Cloudflare Worker — one command, from any directory, with no
clone of this repository, because the installed app carries the Worker with it:

```sh
/Applications/teamree.app/Contents/Resources/relay/teamree-relay deploy
```

`relay/README.md` is the whole of it, including the one fallback for a team that
will not use Cloudflare. `docs/teamwork.md` is the plan the relay is part of.

## Running it

```sh
npm install
npm run dev
```

`npm test` runs the suite, including an acceptance pass that drives a real
runtime over the real socket. The tests that drive the real relay need
`relay/dist`, and would skip without it — 34 of them — so the suite checks for it
before it starts, however it was started, and refuses to run rather than quietly
running less than it claims. `TEAMREE_SKIP_RELAY_TESTS=1` is the way to say you
meant it. Building it is `cd relay && npm ci && npm run build`, which is what the
refusal says too.

`npm run typecheck`, `npm run lint` and `npm run format:check` are what CI
checks, on a single macOS runner, alongside the relay's own suite, the build, the
smoke test, the packaged app, and the app inside the `.dmg` that is published.

## Trying teamwork

`examples/ledger` is a small project that exists to be worked in — no
dependencies, a test suite that runs in a second, and a task list chosen so two
people can take a task each without colliding. `node
examples/init-example-repo.mjs ~/teamree-example` turns it into a real
repository.

**[`docs/trying-teamwork.md`](docs/trying-teamwork.md) is the thing to follow**:
two people on two Macs, start to finish — the relay, both keys committed and
pushed, and each other's worktrees in the sidebar — with a troubleshooting
section for what actually goes wrong. All five milestones have landed — identity,
the relay and presence, watching a teammate's pane, typing into one, and
staleness — and the runbook is exact about the one thing still untested, which is
two Macs in two places. `docs/teamwork.md` is why it is built this way, and
`relay/README.md` is how to stand a relay up.

## Packaged builds

Packaging is electron-builder, configured in `electron-builder.yml`. Every command
rebuilds the app first, so a package is never made from stale output.

Only the macOS command is built by CI and only its artifact is released. The
other two are kept configured and are described here as what the configuration
produces, not as something that has been seen to work lately — `ROADMAP.md` is
exact about which of them has ever been launched.

| Platform | Command | Artifacts in `dist/` |
| --- | --- | --- |
| macOS | `npm run package:mac` | `teamree-<version>.dmg`, universal (Apple Silicon and Intel in one file) |
| Windows | `npm run package:win` | none — the build fails; see below |
| Linux | `npm run package:linux` | `teamree-<version>-x86_64.AppImage`, `teamree_<version>_amd64.deb` |
| The one you are on | `npm run package` | as above, for the host platform |

Two more, for working on packaging itself:

- `npm run package:dir` — unpacked app only, no installers. Much faster.
- `npm run package:verify` — launches the packaged app against a throwaway
  profile, drives it through the CLI the app ships, opens a real PTY in it and
  reads the output back. This is the check that matters: `node-pty` needs its
  native binary outside the asar, plus an executable `spawn-helper` on macOS and
  two backends and a ConPTY sidecar on Windows, and only spawning a shell proves
  all of that survived packaging. It takes a path, so it can be pointed at an
  app anywhere — CI points it at the copy inside the mounted `.dmg` as well as
  at the unpacked one.

  On a universal build it also checks both architectures' `node-pty` binaries
  statically — present, executable, and a Mach-O for the architecture whose
  directory they are in. It can only *run* one of them, which is whichever the
  machine is. The Intel half of a universal build has never been executed by
  anything, here or in CI; closing that needs an Intel Mac, or an Apple Silicon
  one with Rosetta and the app launched under `arch -x86_64`.

`npm run package:win` is in the table because the configuration is still there,
not because it runs. It fails in the `afterPack` hook, and would on any machine.
The Windows prebuilds are excluded at the *top level* of `files` in
`electron-builder.yml`, so they are excluded for every platform including
Windows; `scripts/afterpack.mjs` then looks for `pty.node` in
`prebuilds/win32-x64` or in `build/Release`, and on Windows node-pty's own
prebuild script exits successfully because the source prebuilds exist, so
`build/Release` is never created either. The hook throws, which is what it is
for — a Windows package with no PTY in it builds cleanly and then opens no
terminal. Reviving Windows starts with deleting the two exclusion lines that
comment names.

On Linux, run both the smoke test and this one under a virtual display:
`xvfb-run --auto-servernum npm run package:verify`. Electron also refuses to
start as root unless the sandbox is switched off; the scripts detect that and
pass `--no-sandbox` themselves, so a container needs no special invocation.

Each platform's artifact must be built on that platform. `node-pty` publishes
prebuilt binaries for macOS and Windows but none for Linux, where `npm install`
compiles one — so a Linux package built anywhere else would contain no working
terminal at all. `.github/workflows/build.yml` runs every check and the one
build this project publishes, on a single macOS runner; both `ci.yml` and
`release.yml` call it rather than restating it. Its matrix has one entry, kept
in that shape so that adding a platform back is a block rather than a rewrite.

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

On macOS, putting it on `PATH` is a button: an installed build offers it once on
first run, and the sidebar and the command palette both carry **Put teamree on my
PATH** until the link is made. Everywhere else it is one command per platform.
Both live in [`docs/install.md`](docs/install.md) with the rest of what an
installed copy needs — including the reason a `.deb` install already has a
`teamree` on `PATH` that is the application rather than the CLI.

With the app running:

```
$ teamree status
```

If the app is not running, the CLI says so and exits 3 rather than hanging.

## Releases

`.github/workflows/release.yml` turns a `v*` tag into a download. It does not
build it itself: it calls `.github/workflows/build.yml`, the same workflow
`ci.yml` calls on every pull request, so what gets published has been through
typecheck, lint, format, the full suite, the smoke test, and the packaged-app
check twice — once against the unpacked app, and once against the copy inside
the mounted `.dmg`, which is the file that actually leaves the building. A
release pipeline of its own would be a second, shorter sequence that nobody
reads the output of, and the check it would be tempting to leave out —
launching the artifact and spawning a PTY in it — is the only one that can tell
a package that built from a package that works.

The job then attaches the `.dmg` to the release along with a `SHA256SUMS.txt`,
and writes notes that say plainly that nothing is signed and what macOS will do
about that. Unsigned software that arrives without explaining itself gets
clicked through or thrown away, and neither is what you want from somebody
trying it for the first time.

Nothing has been released yet. No tag has been pushed and this workflow has
never run, so its first run is also the first test of the parts that need
GitHub: the artifact handoff between the two jobs, and `gh release create`. One
of those is worth settling beforehand rather than at the end of a
three-quarter-hour build. Publishing needs `contents: write`, which the workflow
asks for — but a repository whose **Settings → Actions → General → Workflow
permissions** is set to read-only overrides that, and the failure looks like a
403 from `gh` after everything else has passed.
