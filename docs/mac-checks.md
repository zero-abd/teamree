# What only a Mac can check

Thirty pull requests have merged since `v0.1.2` — 225 files, +20,462/−1,715 —
and every gate that approved any of them ran on Linux. A good deal of this app
is not reachable from there. jsdom computes no styles and presses no keys,
`codesign` and `hdiutil` do not exist, and a packaged app only ever executes the
one architecture the machine packaging it happens to be.

So that verification is outstanding rather than done. It was written down across
five pull request bodies and is collected here instead, because a pull request
body is not somewhere anybody looks in six months.

Two standing facts first, because they decide how much of the rest to believe.

**The Intel half of the universal build has never been executed by anything.**
`scripts/verify-package.mjs` checks both darwin slices statically — `pty.node`
and `spawn-helper` present under each of `darwin-arm64` and `darwin-x64`, the
helper executable, each file a Mach-O for the architecture whose directory it is
sitting in and no shorter than its own header says it must be — and then it
launches the app, which runs whichever slice the machine is. Every Mac that has
packaged this has been Apple Silicon. The x64 half is asserted and has never run.
If the universal merge or the ad-hoc signature damaged it, the release goes out
green and every Intel Mac opens no terminal, which for this app is the whole app.

**The smoke test asserted nothing until it was fixed.** It constructed a
`BrowserWindow` of its own and loaded `out/renderer/index.html` into it, so
nothing in that process ever started the runtime: every call the renderer made
was rejected, the window put up "Could not reach the runtime", and the gate
called that a pass. `v0.1.0`, `v0.1.1` and `v0.1.2` were each released through
it, on a Mac, with that step vacuous. It now boots `out/main/index.js` — the file
the packaged app starts — and asserts that a call placed by the renderer over the
real bridge is answered. 0.3.0 is the first release where that step will have
meant anything, which is a reason to treat the rest of this list as the coverage
rather than as a formality.

## Before you cut 0.3.0

These four stop the release, and three of them are cheap.

**`rm -rf dist` before anything else.** `v0.1.2` was cut from that machine, so
`dist/` still holds `teamree-0.1.2.dmg` and `teamree-mac-universal.dmg`.
`scripts/release.mjs` counts the `.dmg` files it did not name itself and refuses
when there is more than one — and it counts them *after* `package:mac`, so the
refusal arrives fifteen-odd minutes in, having spent the whole packaging step
first. `scripts/verify-signing.mjs` is stricter still: its `soleDmg()` counts the
stable copy too, so any leftover image fails it. Emptying the directory costs
nothing and avoids both.

**`cd relay && npm ci`, if `relay/node_modules` is not there.** The release
refuses up front without it: the relay build is a gate, and the peer tests would
skip.

**`gh auth status`.** Refused up front as well, on a dry run too — it is the step
most likely to fail, and a rehearsal that skipped it would not be rehearsing it.

**Run `npm run install:verify` by hand, and expect it to be the first time it has
finished.** It installs the packaged bundle at `/Applications/teamree.app`,
quarantines it both ways a download arrives, and runs the `xattr` command read
out of [`install.md`](install.md) itself, so the one instruction every first-time
user is given cannot rot. [`releasing.md`](releasing.md) once claimed a hosted
runner had run it. It had not: the script died on its macOS half on an unimported
`existsSync`, a fault that arrived in the same commit as the script and as the
claim, so the command has never once completed. What had run was its first half,
which compares the document against the release notes, stops before the bundle on
anything that is not a Mac, and exits 0 — and exiting 0 was read as a pass. The
import is fixed. Confirm it passes for *both* shapes: a bundle marked at the top,
and one marked file by file.

It is deliberately not a gate, because it writes into `/Applications` and would
replace whatever copy is installed there. `docs/install.md` has changed since the
last release, which is the condition [`releasing.md`](releasing.md) names for
running it.

The command itself, from a clean tree on `main`:

```sh
rm -rf dist
npm run release:dry-run      # every gate, nothing created
npm run release              # the same, and then tags v0.3.1 and publishes
```

Both default to the tag matching `package.json`, which is `v0.3.1`. The run
prints the notes it is about to carry before it asks you to type the tag.

One thing that is not a failure, so that it is not a surprise: the packaged app
that `package:verify` launches schedules an update check thirty seconds after
startup, so that step makes one request to `api.github.com` from its throwaway
profile. Nothing waits on it and a failure is a log line.

## Check these first in the app

Ordered by how bad the failure would be.

**1. Open a pane on an Intel Mac, or under Rosetta.** `arch -x86_64` on an Apple
Silicon Mac with Rosetta installed is the cheap version; a real Intel Mac is the
honest one. Expect a shell prompt in a pane like any other. Anything else means
the universal merge or the ad-hoc signature damaged the x64 prebuild, and the
build should not ship. This is the check the section above says nothing has ever
run, and it is first because it is the only item on this list that breaks the app
completely for a whole class of user.

**2. Open two or three panes, print something in each, ⌘Q, relaunch. Then do it
again, pressing ⌘Q twice quickly.** Expect every pane back under a dim
`[record — up to <date> <time>, nothing running]` line, with its old output
above an `[end of record — new shell below]` line. A pane that comes back empty
means the flush is not landing: look in
`~/Library/Application Support/teamree/scrollback/` for one `<terminal-id>.json`
per pane. No `.json` files at all means the write never ran; files ending `.tmp`
left behind mean it was cut off mid-write.

The second press is what the second run is for. `before-quit` cancels a quit
rather than deferring it, so the windows sit where they are for the second or two
the teardown takes and ⌘Q looks like a key that did nothing; a second press used
to be let straight through and end the process mid-flush, losing every open
pane's transcript. Expect the same full transcripts either way. Time the pause
while you are there: if the windows stay on screen for more than two or three
seconds it reads as a hang, and that is worth addressing with feedback rather
than only with correctness.

**3. `git push` from the teamwork panel, over https, on a machine whose
credential is only in the login keychain.** Launch the packaged app from Finder
for this — a Finder launch gets launchd's minimal `PATH`, which holds
`/usr/bin/git` and not Homebrew's, and that is the git a user actually gets. The
app runs git with `GIT_TERMINAL_PROMPT=0` and an emptied `GIT_ASKPASS`, so it
cannot be prompted for anything. Expect either a push with streamed progress, or
the specific refusal naming `git config --global credential.helper osxkeychain`.
A hang, or a Keychain access dialog appearing from nowhere, is the failure to
catch: the first means something is waiting on a prompt nobody can answer, and
the second means the keychain is being reached by a route the refusal text does
not describe.

**4. Switch theme from the palette with panes open.**
Expect every terminal background to change in the same frame as the sidebar.
xterm cannot read CSS, so the panes re-read the custom properties off the root
element in an effect of their own, and `App` now writes them in a
`useLayoutEffect` so that its write lands before any child's read. If the panes
change only on the *next* switch — showing you the theme before last — the layout
effect is not taking. Confirm that ⌘, opens Settings at all while you are
there: every other item in the app menu is an Electron role, and whether a role
claims that chord is the one thing here that was settled by reading Electron's
table rather than by pressing the key.

**5. Have a teammate ask to type while teamree is behind another window.** The
consent prompt is modal and cannot be dismissed, and nothing bounces the Dock or
posts a notification — `app.dock` is not used anywhere in the app. Expect to find
the prompt only by switching to teamree, which is the behaviour as built; decide
whether it is the behaviour you want. Watch the countdown too: Chromium throttles
a hidden page's timers, so the seconds may sit still and then jump. The decision
itself runs on the runtime's sixty-second timer rather than on the renderer's, so
a stale number is cosmetic — but confirm that the dialog closes itself when the
request expires, rather than standing over a request that is already gone.

**6. Quit in the first second after launch, with panes to restore.** Relaunch
with two or three panes recorded and press ⌘Q as the window appears. Expect the
same transcripts back on the next launch as in check 2, and no stale
`runtime.sock` or discovery file left behind. A quit in that window used to
return early and end the process with the restored PTYs still running; it now
holds the quit until the launch finishes and then runs the ordinary teardown,
giving up after a five-second grace so that a launch which never finishes cannot
make the app unquittable. There is a real test behind that, over a real PTY, and
it has only ever been run on Linux.

**7. Select text in a *watched* pane and copy it.** The watched view letterboxes
the owner's picture with a CSS `transform: scale()` on the xterm element, with a
WebGL renderer inside it. Layout is unaffected by a transform, so the fit
arithmetic is right; whether xterm's hit-testing agrees with a scaled element is
the one thing on this list that could not be reasoned out from the code at all.
Expect the selection to land under the pointer. If it is offset, the scale is the
reason, and the offset will grow with the distance from the top left corner.

**8. Make a resume fail, and read what the pane says about it.** Two shapes, and
the cheap one first: open a pane, start an agent in it, type nothing at all, ⌘Q,
relaunch. Expect that pane *not* to resume — a pinned session id is a reservation
and an agent writes a conversation only once somebody has typed one, so a
never-typed pane comes back running its agent afresh, with what it printed last
time replayed above under the same record lines as check 2 and no badge claiming
otherwise. A pane that comes back dead here is the old behaviour, and it is the
bug this check exists downstream of.

The genuine failure takes one more step, because the case above is now the case
that no longer fails. Open an agent pane, type something into it and let it
answer, ⌘Q, then delete that conversation from wherever the CLI in question keeps
its conversations on disk, and relaunch. Expect the pane to come back, run its
resume, and be refused in a line by the agent itself, which then exits — and
expect the app to say so rather than leave you looking at it: the badge stops
reading resumed, the pane's old output is there above under an
`[end of record — resume attempt below]` line rather than the usual one, and a
dim bracketed line at the bottom reads
`[resume refused — agent exited <code>, record above; open a new pane for a
fresh one]`, immediately under the agent's own reason. The pane is dead, and that is the recorded behaviour rather than the
failure — [`../ROADMAP.md`](../ROADMAP.md) records it under "Known gaps", along
with why a pane that quietly started a fresh conversation instead would be the
worse answer.

Then relaunch once more without touching anything. Expect that pane to come back
*running*, with a fresh agent above the whole of the failed launch: the refusal
is written down the first time it happens, so it costs one restart rather than
recurring on every launch for the life of the pane.

Two failures to catch, neither of them visible in the pane at the time. A pane
still wearing the resumed badge over a dead agent, with nothing written into it,
is the whole defect back. And quit once more after looking: the record on disk
for that pane must still hold what it printed before the restart, not the agent's
one-line refusal. A resume used to be bet on — the transcript withheld on the
assumption it would work, then overwritten by the refusal on the next quit — so
one failed resume destroyed the output it was supposed to be protecting. Check
`~/Library/Application Support/teamree/scrollback/<terminal-id>.json` if the
replay on the launch after that looks short.

### One thing not to mistake for a failure

Force-quit a pane mid-build — Activity Monitor, or `kill -9` — and its transcript
comes back, but short. A running pane is checkpointed fifteen seconds after it
last printed, so what is lost is bounded by that interval rather than by the
whole run; an idle pane arms no timer at all and costs nothing. Expect the last
few seconds before the kill to be missing, and expect every *exited* pane's
record to be complete, since a pane's exit writes its own. That is the bound the
feature promises, not a durability guarantee, and it is on this list only so it
is not read as the failure in check 2.

## Three permissions only a Mac can confirm

[`local-access.md`](local-access.md) writes down who on this machine can drive
the runtime, and the short answer is two file permissions. Both were read off a
real app launch, but that launch was on Linux under the same Chromium and the
same libuv the Mac build ships, so three links in the chain are still asserted
rather than seen. None of them blocks a release; the first costs ten seconds.

- **`ls -ld ~/Library`.** Expect `drwx------`. This is the outer of the two
  directories that keep other accounts away from the socket, and it is macOS's
  doing rather than this app's — which is exactly why it is worth looking at
  once instead of repeating it from memory.
- **The mode Electron gives the user data directory, on a Mac.** `npm run smoke`
  asserts it and prints it: expect `smoke: user data directory 0700, CLI socket
  0600`. The smoke test points Electron at a directory that does not exist yet
  so that the mode it reads is Electron's rather than a temporary directory's,
  and the run fails if either value is wrong. So this needs nothing done to it —
  it needs watching once, because a green gate nobody has read is the thing this
  document exists about.
- **That macOS refuses a connection to a socket the connecting account cannot
  write.** This is the mechanism the socket's `0600` depends on, and it was
  watched happen on Linux one mode at a time: `0777` and `0766` let another
  account connect, `0755`, `0700` and `0600` refused it with `EACCES`. xnu is
  believed to make the same check. Confirming it takes a second account and one
  line — `sudo -u <other> nc -U ~/Library/Application\ Support/teamree/runtime.sock`
  with teamree running — and expects a permission error rather than a prompt
  waiting for input. If it *connects*, the socket's mode is decorative on macOS
  and the second half of `local-access.md` needs rewriting, though nothing
  changes for a single-user machine, where the directory is what keeps that
  account out and the mode is never reached.

## Gates that have never been able to fail here

Every gate in `scripts/release.mjs` was given the defect it claims to catch — the
defect constructed, introduced, run, and reverted — and all but two refused it.
Those two are fixed: `npm run lint` now runs `--deny-warnings`, having previously
printed a duplicate object key and an unreachable `return` and passed anyway, and
`verify-quarantine-advice`'s fence parser no longer reads the lower half of the
document it checks inside out.

What follows is the remainder — the gates whose failing path cannot be reached
from Linux at all, and the one thing to do to each of them on a Mac. None of it
blocks 0.3.0. It is worth an hour the next time you package, because a gate
nobody has watched fail is a gate nobody knows works.

- **`package:mac` and the signing guard.** Point `CSC_NAME` at an identity that
  is not in the keychain and confirm it exits 1 with `asked to sign as …, but the
  packaged app is adhoc`. That guard exists because electron-builder logs
  "skipped macOS application code signing" and exits 0, which would otherwise
  produce an unsigned build from a run that said it was signing.
- **The `.dmg` mount check.** Hand `verifyInsideTheImage` a truncated file, or one
  that is not a `.dmg` at all, and confirm the run stops with `the app inside the
  .dmg did not verify`. Then delete `teamree.app` from a mounted image and confirm
  `verify-package` refuses rather than passing an empty mount. It is not exported,
  so it has no unit test.
- **`verify-signing`, against real commands.** `codesign`, `spctl` and `stapler`
  do not exist on Linux, so all five checks come back "could not run" and any
  build reads as unsigned. On a Mac with a Developer ID: strip the notarization
  ticket from the `.dmg` and confirm `stapler (dmg)` fails the run; re-sign the
  app ad-hoc after a signed build and confirm `readSignatureKind` reports `adhoc`
  and that `--require-signed` refuses it.
- **`verify-package`'s post-launch half.** Everything from the point it spawns the
  packaged binary — the discovery file, `cli status`, worktree creation, the real
  PTY — needs a real Electron macOS binary. Move `Contents/Resources/cli/teamree`
  after launch and confirm it fails with `the packaged app is wrong about its own
  CLI`. The Mach-O block above it has been demonstrated; this half has not.

## The screen captures

The hero clip, the feature clips under `site/public/demos/` and the
`screenshot.png` fallback were retaken from a `main` build after 0.2.0, in a
hidden window on a throwaway profile against a small demo repository. The
`teamwork` clip's teammate is a headless runtime on the same Mac, through a
local relay; it shows watching a pane, not the consent prompt. `og.png`, `favicon.svg`
and the icon set are the mark rather than the app, so they never needed
retaking.
