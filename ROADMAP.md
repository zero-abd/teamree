# Roadmap

Milestone 1 is single-user and is complete; its remaining limits are under "Known gaps".
Milestone 2 is teamwork, and its six lettered stages have all landed — built and tested,
but never yet run between two machines in two places.

## Stack

- TypeScript end to end
- macOS, and only macOS: the one platform packaged, published and supported
- Electron for the shell, so a terminal and the chrome around it are one document —
  one engine, one palette, one language
- React + Vite for the renderer
- A runtime owning git, worktrees, terminals, and state
- One contract in `src/shared` typing the runtime, the GUI, and the CLI from a single declaration
- A `teamree` CLI over a local socket, so a coding agent can drive the app

## Architecture

Three consumers, one contract. The renderer reaches the runtime over Electron IPC through
an isolated preload bridge. The CLI reaches the same runtime over a unix socket, speaking
newline-delimited JSON. Both are typed from `src/shared/methods.ts`,
so a change to a method signature breaks every caller at compile time rather than at runtime.

## M0 — Scaffold

- [x] Electron + Vite + React + TypeScript builds and launches
- [x] Main, preload, renderer split with strict process boundaries
- [x] Typecheck, lint, format, test wired up
- [x] Headless smoke test that boots the built app

## M1 — Contract and runtime

- [x] Domain entities, wire protocol, and method catalogue
- [x] Method registry, dispatcher, structured errors
- [x] Local socket server with runtime discovery
- [x] Subscription manager for streaming output
- [x] Durable store for projects, worktrees, layouts

## M2 — Repos and worktrees

- [x] Add and track a repo
- [x] List worktrees, reconciled against real git state
- [x] Create a worktree in the background with progress and failure recovery
- [x] Start-from picker: base ref, local branch, commit, remote branch
- [x] Live git status per worktree
- [x] Delete a worktree and optionally its branch

## M3 — Terminals

- [x] PTY sessions with a correct per-platform environment
- [x] Bounded scrollback, readable as a snapshot
- [x] Streaming output, title detection from escape sequences
- [x] Split panes, arbitrarily nested, resizable
- [x] Process-tree cleanup so nothing is orphaned

## M4 — GUI

- [x] App shell: sidebar, main area, status bar
- [x] Projects and worktrees in the sidebar with live status
- [x] Create-worktree flow that does not block
- [x] Terminal panes rendering the split tree
- [x] Keyboard shortcuts with correct per-platform modifiers

## M5 — CLI

- [x] Transport, discovery, and exit codes that mean something
- [x] `teamree status`
- [x] `teamree project` and `teamree worktree`
- [x] `teamree terminal` including read, send, and split
- [x] `--json` on every command

## M5b — Live workspace

The GUI polls today, so work a CLI does is invisible until the next poll and
terminals opened by an agent never appear at all. One coarse invalidation
stream replaces polling entirely.

- [x] `workspace.subscribe` streaming collection invalidations
- [x] Producers wired: projects, worktrees, terminals, layouts, terminal exit
- [x] GUI consumes the stream and drops its poll loop
- [x] `teamree worktree wait`, `teamree terminal wait`, and `teamree terminal run` for agents

## M6 — Acceptance

- [x] End-to-end: create a worktree, open a terminal, run a command, read the output back
- [x] The same flow driven entirely through the CLI
- [x] macOS, Linux, Windows path and process handling
- [x] Packaged build

## M7 — Live status

Status was the one part of a worktree row with no call behind it, so it was only
ever as fresh as the last command boundary.

- [x] A filesystem watch per ready worktree: the checkout and its git directory
- [x] Bursts settled and rate-limited, so a build cannot drive a status read per file
- [x] Degrades to the git directory alone where recursive watching is unavailable
- [x] The watch set follows git's own events, so nothing polls

## M8 — Reviewing the work

Counts tell you whether there is something to look at. They cannot tell you the
file you are about to commit is a stray log.

- [x] `worktree.changes`: every changed path, conflicts first, then staged
- [x] `worktree.diff`: the patch for a worktree or one path in it
- [x] Untracked files diffed as the patch that adds them, which plain `git diff` will not do
- [x] `teamree worktree changes` and `teamree worktree diff`
- [x] A changes panel in the GUI, live off the same watch as the chips

## M9 — Getting around

Tabs stop being a way to navigate somewhere around the sixth one.

- [x] A palette on one chord: worktrees by name, branch or project, and the
      actions worth reaching without the mouse
- [x] Ranking that puts the thing you meant first — whole-query hits over
      scattered letters, word starts over mid-word, initialisms over neither
- [x] The same chord closes it, arrows and Enter drive it, the mouse agrees
      with the keyboard about what is selected

## M10 — Picking a session back up

A PTY is a child process, so quitting ends it. For a coding agent that was
never the valuable part: the conversation is, and the agent already keeps it on
disk under a session id.

- [x] A durable record per terminal: worktree, directory, shell, and the agent
      session it was running
- [x] A session id pinned at launch where the agent's CLI allows one, so the
      next launch has an id to resume rather than a guess to make
- [x] Startup relaunches each recorded pane under its own terminal id, so
      stored pane trees need no rewriting
- [x] Agent panes resume; every other command is dropped for a plain shell,
      because restarting the app is not a request to run a deploy again
- [x] The pane says how it got here — resumed, or a new shell — until the user
      types into it, at which point the badge has said what it had to

## M11 — Which of these can actually go in

Several attempts at one task is the point; picking the one that merges is the
question that follows.

- [x] `worktree.mergePreview`: merged in memory with `merge-tree --write-tree`,
      so asking costs the repository nothing and starts no merge to abort
- [x] Conflicting paths named, each once, however many ways git mentions them
- [x] A base ref that does not resolve, unrelated histories, and a git too old
      to be asked each come back as themselves rather than as "clean"
- [x] A branch with nothing the base lacks reads "nothing to merge", never
      "merged": git cannot tell a finished branch from one that never started,
      and the row must not talk somebody into deleting unfinished work
- [x] `teamree worktree merges`
- [x] The answer shown per worktree in the sidebar, capped at four reads in
      flight so a refresh cannot fan out a git process per row

## M12 — Committing from the app

The first thing here that writes to a repository, so it is built to refuse
rather than to guess.

- [x] `worktree.commit`: stages only the paths named, or commits what is
      already staged — there is deliberately no "commit everything"
- [x] Refuses an unresolved conflict, and names the files, rather than
      committing the markers as if they were code
- [x] Refuses an empty message and an empty commit, and leaves the history
      untouched when it refuses
- [x] Reports what the commit actually captured, not what was asked for
- [x] `teamree worktree commit`, with paths after `--` so none reads as a flag
- [x] Staging and committing from the changes panel: ticking is browsing, and
      nothing reaches git's index until the commit itself

## M13 — Sending it somewhere

The only call in the git layer that leaves the machine.

- [x] `worktree.push`, with an explicit refspec so `push.default` cannot land
      the branch under another name
- [x] No force, and no flag to ask for one: the value of a force push is
      overwriting somebody else's history
- [x] Sets the upstream on the first push, and knows the difference between
      sending work and having had nothing to send
- [x] Uncommitted work is counted and reported rather than blocked, because
      what landed is then not what is in the worktree
- [x] A rejection is explained without git's hint to force it
- [x] `teamree worktree push`
- [x] A push button in the GUI, showing what it would send and saying what it
      did — including what stayed behind uncommitted
- [ ] Opening a review on the forge after a push

## M14 — Starting an agent

The app is built around coding agents and had no way to start one: you opened a
terminal and typed the name yourself.

- [x] `agent.list` probes PATH for the agents teamree knows how to resume,
      rather than asking the user to configure a list that goes stale
- [x] First match wins, the way a shell resolves it, and an empty PATH entry is
      not treated as the working directory
- [x] A button per installed agent in the header and in an empty worktree, and
      `teamree agent list`
- [x] A pane started this way is an ordinary pane: the runtime pins its session
      id, so it comes back resumed after a restart like any other

## M15 — Not losing somebody's afternoon

- [x] Removing a worktree from the sidebar is no longer forced. The runtime
      already refused to delete a checkout with uncommitted work; the GUI was
      passing `force` unconditionally and defeating it
- [x] That refusal now raises a confirmation naming what would be thrown away,
      and the removal only proceeds from there
- [x] A clean worktree still goes without a dialog, so the one that matters is
      not the one people learn to click through

## M16 — What the worktree actually did

An agent that finishes commits its work, and at that moment every view in the
app went quiet: the changes list emptied, the chips dropped to zero, and a
worktree that had just produced a day's work looked like one where nothing
happened.

- [x] `worktree.log`: the commits this branch has that its base does not,
      newest first, scoped to `base..branch`
- [x] Fields separated by NUL, since a commit subject can contain newlines and
      a line-based reader turns one commit into two
- [x] `teamree worktree log`, and a commits section in the changes panel
- [x] An empty changes list now distinguishes "everything here is committed"
      from "nothing changed here yet"

## M17 — What each agent is doing

The sidebar answered "what has changed in this worktree" and never "which of
these five agents needs me", which is the question running agents in parallel
creates.

- [x] Each pane reports whether output is still arriving, and the runtime
      announces only the two edges — busy, and quiet again — rather than one
      event per chunk
- [x] Worktree rows carry their panes underneath, each with a state dot and how
      long since it last said anything
- [x] Four states and no more: working, waiting, finished, failed. Teamree
      watches a PTY, not an agent's protocol, so "waiting for permission" is not
      knowable here and is not claimed
- [x] The sidebar's filter box is gone; the palette already finds things by
      name, branch and project from anywhere

## M18 — Which one of them needs you

M17 put each pane's state on its worktree row, which answers the question one
worktree at a time. With eight agents running, finding the one that wants you
still meant reading the whole tree.

- [x] One flat view of every pane in every worktree, taking the main area:
      which agent or shell it is, where it lives, its state, and its silence
- [x] Ordered by what would make somebody look — failures, then work in
      progress, then waiting, then finished — and longest-silent first inside a
      group, because the pane that has been sitting there is the neglected one
- [x] Counts per state, so "3 waiting" is read rather than tallied
- [x] A row opens its worktree and focuses its pane, which is also how the view
      is left
- [x] The same four states as the sidebar, derived by the same module: two
      readings of one PTY would be two things to reconcile
- [x] Live off the existing `terminals` invalidation, with the silences kept
      counting by a clock of their own — no new runtime method

## M19 — Finding something in a pane

Scrollback is where the answer usually is, and the only way to reach it was to
scroll.

- [x] A find bar over the pane, on the chord, scoped to that pane alone
- [x] Case and whole-word toggles, match counts, next and previous
- [x] Absolutely positioned over the terminal, taking no layout space: a bar
      that took space would resize the PTY under a program being read

## M20 — Starting work, not making directories

The create dialog made a checkout and left you to go and find an agent button.
Nobody wants a worktree; they want a thing done in one.

- [x] One dialog: describe the task, pick the agent, pick what it starts from
- [x] One submission creates the worktree, waits for it, and starts the agent
      inside it — the wait rides the existing change stream rather than a poll,
      serialises its reads so a burst of events cannot land answers out of
      order, and gives up after ten minutes rather than holding a subscription
      open for the life of the window
- [x] The footer never promises what it cannot deliver: an empty agent list
      means "not asked yet" until the startup probe answers, and only then
      "none on PATH" — at which point the button says "Create worktree"
- [x] The dialog closes on submit; creation narrates itself on the sidebar row

## M21 — What a pane actually said

The sidebar said a pane was working. It did not say what it was working on.

- [x] The last line each pane printed, on its row, replayed the way a terminal
      would — carriage returns, backspaces and erase-line sequences collapse a
      progress bar to its final state rather than the fragment that ended it
- [x] Bare prompts, spinner frames and rules refused; a tail that ends inside
      the alternate screen buffer refused outright, because the bottom row of a
      full-screen program is not the end of a story
- [x] Cheap on purpose: a 4KB tail, only for worktrees on screen, a floor per
      pane, a cap per tick, a quiet pane read only once output has arrived, and
      an exited pane read once more and then never again — no subscription,
      which would push every byte an agent prints into the renderer to show one
      line

## M22 — A teammate's pane in the window, not over it

A watched pane was a card fixed to the bottom-right corner at 70% of the window:
one at a time, over whatever was underneath, and gone the moment you looked at
anything else. It was the one surface in the app that could not be moved,
resized or closed with the chord that closes panes — which is a strange thing
for the surface whose whole job is to be read carefully.

- [x] It is a pane: a cell beside your own, with the gutter that sits between
      two of yours, the pane bar, the close button, the focused border, and a
      slot in the cycle the next-pane chord walks
- [x] Several at once, because a second pane is a second cell rather than a
      second card — two teammates side by side is the thing one card could not do
- [x] Held one level above the worktree's own pane tree, which is about lifetime
      rather than layout: the board, teamwork's setup panel and a tab switch each
      replace what is under them, and a watched pane inside any of them would
      unmount on the next click — closing a subscription and reopening it, paying
      the relay's budget twice for a pane nobody stopped watching
- [x] What made it *not* one of your panes is untouched, because none of it was
      ever about where the window put it: the size is still the owner's and
      letterboxed, typing is still a request, the bar still says whose machine a
      keystroke lands on, and a gap from the relay's budget is still written into
      the stream where it happened

## M23 — Saying that a newer build exists

Three releases had shipped and nothing in the app had ever mentioned a fourth.
Somebody who downloaded the first `.dmg` ran it until a person told them
otherwise.

- [x] `update.state`, `update.check`, `update.setAutomatic` and `update.download`:
      the newest published release, compared by semver precedence and never as
      strings, in a card in the corner when there is one
- [x] A check, and deliberately not an updater. These builds are unsigned and the
      mechanism a Mac app replaces itself through validates the replacement's
      signature, so the card does the half that is available: what is out, that
      release's notes, and the download — and sends the reader to
      `docs/install.md`, where the quarantine advice is kept honest by a script
- [x] Nothing waits on it: the first check is armed half a minute after startup
      and awaited by nothing, GitHub is asked at most once every six hours with
      the clock in the workspace file rather than in memory, and a failed check is
      a log line rather than a dialog
- [x] A check somebody asked for always answers — including "you are on the
      latest release" — because a menu item that does nothing visible reads as
      broken
- [x] The answer is treated as what it is, text from the internet: the tag has to
      match the shape of this project's tags before it reaches a URL, the download
      has to parse to an `https` address on github.com under this repository, the
      body is read through a byte budget, and the notes are flattened to plain
      text in a text node

## M24 — The colours are the user's

The palette was eleven stylesheets deep in one hard-coded near-black, so the only
way to have a different one was to edit the source.

- [x] A true `#000000` ground by default, four presets, and all forty-two colours
      editable behind a disclosure — from the sidebar rail, the command palette,
      and `Cmd+,`, which is where a Mac user looks first
- [x] One derivation from a seed, so a palette somebody builds by hand goes
      through exactly the ramp a shipped one does, and it ends in a legibility
      pass: every ink is pushed off its surface until it clears its WCAG target,
      which is what makes an editor this open safe to ship
- [x] `tokens.css` keeps the literals so the first frame is painted before any
      script runs, a test recomputes them so the two copies cannot drift, and the
      choice is read before the window exists so the frame Electron shows first is
      already the right colour
- [x] Terminals follow the window: all sixteen ANSI colours mapped where eight had
      been silently keeping the emulator's own defaults, the pane taking the
      window's ground so a pane and the chrome around it are one surface, and a
      theme switch reaching panes that are already open

## M25 — Saying what the setup is doing

Two complaints, one report: setting a team up worked and was confusing, and step
4 appeared to hang at `git push` with nothing to show for it.

- [x] The push was never hanging; it had nothing to say. It runs with
      `--progress` and streams git's own stderr to the step, which says how long
      it has been going and when git has gone quiet, with a Stop while it runs and
      a Try again afterwards naming the one thing to do first — which for a
      rejection is a pull and never a force
- [x] ssh runs in batch mode. `GIT_TERMINAL_PROMPT=0` stops *git* prompting and
      does nothing to ssh, which opens `/dev/tty` directly for a passphrase or an
      unknown host key — behind this app's own window, where nobody can answer it.
      A credential refusal now arrives as itself, naming the command that fixes it
- [x] A stopped or timed-out publish is a result with the commit still in it
      rather than a throw that loses the half that worked
- [x] The panel asks which end of teamwork you are on before anything else, and
      every step says what the machine at the other end is waiting on while it is
      not done — the half nobody could see. A joiner with no `.teamree/relay` is
      told to wait for their teammate rather than quietly encouraged to stand up a
      second relay
- [x] It ends on four separate verdicts — key, relay, push, connected — because
      half-working is the ordinary outcome here, and on the invitation to send,
      written out and copyable, naming the URL to clone

## M26 — All of it in one window

Five branches landed in a few hours and none of them had ever been rendered
beside the others. A question about a teammate's keystrokes is a modal that
nobody in this window opened, and three of the collisions were that one fact
seen from three places.

- [x] Chords no longer fire underneath a modal the window did not open: a consent
      prompt refuses Escape, so a chord that acted behind it acted on a window the
      person could not get back to until they had answered
- [x] Two modals no longer both trap the keyboard. `Modal` keeps a stack and only
      the innermost answers keys, so the dialog underneath cannot pull focus out of
      the prompt on top
- [x] Neither corner card draws under a scrim any more. Each says in its own
      header that a card behind a modal is a card being talked over, and each now
      asks one place what is on top of the window rather than knowing about the
      half of the answer that existed when it was written
- [x] A teammate's pane repaints when the palette changes, like every other pane —
      it was written while the palette could not change

## M27 — What the pane said before the restart

A pane came back in the right directory with an empty screen. The build that
failed at midnight and the migration that stopped halfway had both been printed
into a buffer that died with the app, and the only trace left of either was that
the pane existed.

- [x] Each pane's output kept as a capped tail beside the workspace file, one
      small file per pane, written when the pane exits and again on the way out
- [x] And checkpointed while the pane is still running, which is the pane worth
      keeping: fifteen seconds after output, armed by the output itself so a
      pane sitting at a prompt holds no timer and costs nothing, never twice
      inside the interval however much is printed, and skipped outright when the
      tail would say what the file already says
- [x] A restored pane opens on that record, under a line saying what it is and
      above a line saying where the new shell begins — nothing in it can be
      taken for something that is still running
- [x] Still nothing re-issued. A record is bytes, and putting bytes back on a
      screen runs nothing: the refusal in `session-restore.ts` is untouched
- [x] Replayed through an allowlist that keeps text, whitespace and colour and
      drops every other sequence, so a stored escape cannot answer a cursor
      report into a shell that never asked, write the clipboard, rename the
      window or reset the emulator on the way in
- [x] An agent pane that resumes its conversation is not also handed a
      transcript of it
- [x] Pruned with the pane it belongs to, the way a mute is, and swept at
      startup of anything a crash orphaned

## Known gaps

Milestone 1 is complete and verified. These are the honest limits of what it does,
recorded so none of them is discovered by surprise later.

- **`teamwork.status` has a third answer now.** This entry used to say the method
  refused a project the store plainly had, for as long as the peer service had not
  reconciled after `project.add`, and that is no longer true. A project that exists
  and has not been read is `state: 'unread'` — its own answer, carried by the
  contract, by the window, by `teamree team status` and by nothing on the peer
  allow-list, which has never had this method on it. "No such project" now means
  what it says. What is left is not a gap in this method but the shape of the
  window it names: the reconcile still happens after the event rather than inside
  `project.add`, so the answer is unread for as long as that takes, and the window
  and the CLI both say so rather than waiting.

  And it used to say "`teamwork.presence`, `teamwork.watchers` and
  `teamwork.requests` still refuse in the same window". They do not. They were left
  behind on the grounds that one union would not fit all three, which was true and
  was the reason to work each out rather than to leave them lying: **`presence`**
  takes the union, because its answer is a roster read off the repository and
  `teammates: []` is a finding — it says the repository was read and holds nobody
  but you, which is `relay: null`'s mistake with somebody's colleagues in it.
  **`watchers`** and **`requests`** answer outright, because nothing in either
  waits on a reconcile: a watcher, a typist and a held burst all arrive over a
  link, a project with no facts has no links, and the mutes and standing
  permissions are the owner's own decisions, restored before the first reconcile
  runs. That last was the worst of the three while it lasted — a restored window
  asking about a pane it was already drawing, told the project it belongs to does
  not exist. The one read that still refuses is resolving a *teammate's* pane, and
  it should: it is asked to act on somebody who cannot be found on a roster nobody
  has opened. It now says that, rather than that the project is missing.

  And it used to be about reads only, leaving the two **writes** of the same
  family out — one of them flagged at the time and one of them not.
  `teamwork.mute`, which is also `teamree team unmute` and the button on every
  pane, and `teamwork.revoke` resolved their project by walking the facts, so in
  this window they refused a pane on screen with "no pane of this machine". That was the worse half, because
  the reads beside them had already been fixed: the window drew a muted pane from
  `watchers` and a standing permission from `requests` and then would not lift
  either, which is not a lie on a screen but a control that visibly does nothing.
  They do it now. Nothing in either wants a reconcile — the durable halves are
  files keyed by this machine's own terminal ids, restored in `start()`; the
  in-memory halves are this machine's own; and the project, the only thing that
  was being looked up, is a fact the workspace holds. So the walk is over the
  workspace, which is where the facts are built from at every reconcile and is
  therefore the same walk one moment later. "No pane of this machine" now means
  what it says, and neither method is on the peer allow-list or ever will be: a
  mute a teammate could set or lift would not be a mute.
- **A repository shared over a filesystem path takes part only if both Macs
  mount it at the same path.** It used to not take part at all. It does now: a
  path origin is normalised into its own namespace — a normalised URL is
  `host/path` and never begins with a slash, a normalised path always does, so
  no path can collide with a URL's key and no existing team's key moved — and
  hashed like any other identity. What cannot be done is prove that
  `/Volumes/team/app.git` on one Mac and `/Users/x/mnt/team/app.git` on another
  are one directory: there is no server to name and no third party to ask, and a
  volume UUID or an inode is a fact about a mount rather than about the
  repository. So the promise is the narrow one that can be kept — same absolute
  path, spelled the same way, is the same project — and almost nothing is folded
  away, because folding case or a trailing `.git` would merge two directories
  that are genuinely different on a case-sensitive or network volume, and
  merging two teams is worse than failing to join them.

  The residual limit is that a *mismatch is not detectable*. Two machines that
  hash different keys do not fail to connect; they never look for each other,
  and both read "nobody is here yet". Nothing local can notice this, so the
  product says the condition instead: the origin field prints the exact string
  it will hash and what the other person must match, the invitation names the
  path to mount at, and the **Connected** step says which path it is matching on
  while it waits. Making a mismatch impossible rather than legible would mean a
  committed identity — a file in `.teamree` that both checkouts pull, the way
  the relay URL already works — which is a larger decision than this one and has
  not been taken.
- **A restarted shell is a fresh shell, but no longer a blank one.** This entry used
  to say that an ordinary pane's scrollback died with the app along with whatever it
  was running, and half of that is no longer true. What a pane printed is kept beside
  the workspace file — never in it — and put back when the pane reopens (see M27):
  the last 128 KiB per pane, reduced to text and colour so that nothing stored can
  act when it is replayed, under a line saying it is a record of a session that has
  ended and above a line saying where the live shell starts. It is written when a
  pane exits, when the app quits, and — for a pane that is still running — fifteen
  seconds after the last output it printed.

  That third write is what a crash, a force-quit and a flat battery reach, and it
  does not make the record complete. **The last fifteen seconds are always at
  risk**, and on a pane printing steadily that is however many lines fit in
  fifteen seconds. The record says so itself rather than leaving it to be
  discovered: the line above a restored pane gives the time the record was last
  written down, not the time the pane stopped, so a reader can see where it
  stops being true. Nothing here is a durability guarantee — it is a bound on
  what is lost, which is a different and smaller promise. The interval is what it
  is because the alternative is paying for it: a checkpoint is a write per pane
  that is producing output, and the shorter it gets the more an app full of busy
  panes writes to disk for a case that is rare.

  The process half stands, and it is the larger half. The PTY still dies with the
  app. A command is still never re-issued unless it resumes something, so a pane
  left on a deploy or a migration now comes back as a shell showing what the deploy
  said, rather than running it twice — which is the honest outcome and not a
  workaround for the missing half. Keeping the process itself alive would still mean
  moving PTYs into a daemon that outlives the app, and that has not been done.
- **One download, universal, unsigned.** A decision, recorded so nobody
  "fixes" it back: macOS ships as a single `teamree-<version>.dmg` carrying both
  architectures rather than a menu of four files. The cost is size and it is
  worth paying — three of those four entries were a mistake waiting to be made
  by whoever had never thought about what is inside their Mac. node-pty is
  shipped for both architectures for the same reason, since `node-gyp-build`
  resolves its binary from `process.arch` at run time and an app pruned to the
  architecture it was packed on opens no terminal on half the Macs it claims to
  support.
- **macOS is the supported platform. Windows and Linux are not, for now.** That is a
  decision rather than a gap waiting to close: macOS is the only platform packaged or
  published, and nobody should pick this up expecting to finish it. What was learned before narrowing is kept
  because it is true. Linux was packaged and launched for real — `npm ci` compiles
  node-pty, both the AppImage and the `.deb` are produced, and the packaged app was
  launched headless, driven through the CLI it ships, and made to spawn a real PTY,
  three times over: as the unpacked tree, as the AppImage's payload, and as a `.deb`
  installed with `dpkg`. It reached green in CI. Windows never did — it was still
  turning up a fresh POSIX assumption on every run — and the Windows installer has
  never been built nor the app started there. `npm run package:win` cannot currently
  succeed either: the Windows prebuilds are excluded at the top level of `files` in
  `electron-builder.yml`, so they are excluded for Windows too, and `afterPack` throws
  when it cannot find `pty.node`. That is the hook doing its job, and it is two
  deleted lines away from building again. The platform-specific code is all still
  present, so putting a platform back is adding to the packaging and the release
  sequence rather than a rewrite.
- **CI ran, was green, and has been removed on cost grounds.** Recorded in that order,
  because all three are true and the last is what matters today. The pipeline ran
  typecheck, lint, format, the relay's own suite, the full suite, the build, the
  headless smoke test, the package and the packaged-app check — the one that launches
  the artifact and drives it — and macOS passed all of it and uploaded a build. It was
  not removed for failing. It was removed because of what it cost: this repository is
  on GitHub's free tier, every job ran on a `macos` runner — billed at ten times the
  Linux rate against the same monthly allowance — and a full run packaged a 190 MB
  Electron app. A handful of pushes spent the month, after which every pull request
  carried a red cross that was about the allowance rather than about the code, which
  teaches everybody to stop reading the checks. So the four workflows are gone and the
  gate is `npm test` and `npm run release` on a maintainer's Mac, with
  `scripts/release.mjs` as the single description of the sequence.

  The cost of that decision is the honest half of this entry: nothing checks a branch
  any more. A contributor who does not run `npm run typecheck`, `npm run lint`,
  `npm run format:check` and `npm test` before opening a pull request has had nothing
  checked at all, and there is no machine anywhere that will notice.

  The pipeline's first four runs all failed, each for a real reason a developer machine
  had been hiding: a stale CLI build, a configured git identity, LF line endings, and a
  sandbox helper that only needs its permissions fixed on a runner. Those fixes are all
  still in the tree, and they are why the local sequence is clean rather than lucky.

  For most of that time the suite it ran was quietly smaller than the one a developer
  runs. `relay/` is a separate package with its own dependencies and its own gitignored
  build; nothing in the workflow produced it, and the tests that spawn the built relay
  as a child process and drive real WebSockets through it — the only ones that prove
  teamwork end to end rather than against a fake — skip when it is absent. So they
  skipped on every run, in a warning nobody reads, and the run stayed green: the
  skipped tests reported as skipped and an exit code of zero, which is
  indistinguishable at a glance from the same number having passed. That fix outlived
  the pipeline that prompted it. `scripts/require-test-environment.mjs` refuses to
  start the suite at all when `relay/dist` is missing or stale — on every machine, not
  only where `CI` was set, because a local run is now the only run there is — and
  `vitest.config.ts` names it as a `globalSetup` so `npx vitest run` cannot slip past
  it either. `npm run release` builds the relay as a gate of its own before the suite,
  for the same reason the pipeline had a step for it. Measured on macOS at this commit:
  the relay's own suite passes 84, and
  `relayProcess.test.ts` and `relayWatch.test.ts` report 23 tests run where hiding
  `relay/dist` makes the same command report 23 skipped and still exit zero — 34
  skipped once `tests/teamwork/scenario.test.ts` and `tests/teamwork/two-peers.test.ts`
  are counted with them.

  Turning them on turned up the reason to watch them. `relayWatch.test.ts` is the most
  timing-exposed file in the suite — a real relay, real PTYs and real wall-clock waits —
  and on a four-core machine busy with other work it failed in two full-suite runs of
  three: once on an assertion that a frame had arrived without having waited for one,
  and once on two `until`s running out of patience, with the file taking forty seconds
  where it usually takes under two. Run on its own it passed eleven of eleven, five
  times over. Nothing about the transport was wrong either time. A machine that is not
  sharing its cores may never see it; the honest position is that this file is exposed
  to load, and if a run goes intermittently red this is the first place to look.
- **The release pipeline is local by design.**
  A `release.yml` was written to build on a `v*` tag through the same workflow CI used
  and attach the `.dmg` and a `SHA256SUMS.txt` to a GitHub release. Its tag trigger had
  already been taken off, so nothing was cut through it, and it has now been removed
  along with the other three, for the cost reason in the entry above.

  What stands in its place is `npm run release` — `scripts/release.mjs` — which runs
  the same sequence on a maintainer's Mac and refuses on a dirty tree, a tag that does
  not name the version in `package.json`, a `HEAD` that is not on `origin`, a release
  that already exists, or a `gh` that is not signed in. It adds one check the pipeline
  never had: the packaged-app check against the copy inside the mounted `.dmg`, which
  is the file that actually leaves here. `docs/releasing.md` is the account of it, and
  `tests/release/` covers the refusals. `npm run release:dry-run` has been run end to
  end on a Mac, through every gate, and stops before creating anything.
- **The shipped relay command does nothing, silently, when it is reached through a
  symlinked path.** `relay/bin/teamree-relay.mjs` decides whether it is the program
  being run with
  `pathToFileURL(process.argv[1]).href === import.meta.url`. `import.meta.url` is
  resolved through symlinks and `process.argv[1]` is not, so through a path
  containing one the two differ, `main()` is never called, and the command exits 0
  having printed nothing and written nothing. Found by running `package:verify`
  against the copy inside a `.dmg` mounted under `os.tmpdir()` — which on macOS is
  `/var/folders/...`, and `/var` is a symlink to `/private/var`. Running the same
  file through its `/private/var/...` spelling writes the project correctly.

  Not a release blocker, which is why it is recorded rather than fixed here: the
  paths a user actually reaches it through — `/Applications`, and `/Volumes` for a
  mounted image — are real directories. It is a
  one-line fix (compare realpaths rather than URLs) and it is a trap for anything
  that invokes the command from a temporary directory, which is what
  `scripts/release.mjs` now works around by mounting at a resolved path.
- **The Intel half of the universal app has never been executed.** A universal `.dmg`
  carries node-pty twice, once per architecture, and the packaged-app check runs the
  app — so it exercises whichever architecture the packaging Mac is, which so far has
  always been Apple Silicon. The `darwin-x64` binaries are now asserted statically: present,
  executable, and Mach-O files for the architecture whose directory they sit in. That
  is more than nothing and it is not the same as running them. If the merge or the
  ad-hoc signature damaged the Intel slice, the release would go out green and every
  Intel Mac would open no terminal, which for this app is the whole app. Closing this
  needs an Intel Mac, or `arch -x86_64` on an Apple Silicon one with Rosetta
  installed. It is the first check in [`docs/mac-checks.md`](docs/mac-checks.md),
  which is where the rest of the verification that needs a Mac is collected.
- **Nothing is signed, and the blank is now filled in rather than closed.** There is
  no Apple Developer certificate and no Windows code-signing certificate, so macOS
  refuses the app as being from an unverified developer and Windows shows a SmartScreen
  panel. It is still the first thing a new user meets. What changed is that buying one
  is now the whole of the work: `npm run package:mac` reads a documented set of
  environment variables and, given a complete set, signs with a Developer ID and
  notarizes; given none it produces exactly the unsigned build it always did; given
  half a set it refuses by name. `docs/releasing.md` lists every variable, the command,
  how to verify the result — and, explicitly, which of those steps nobody has been able
  to run, because nobody involved has a certificate. Two things about that path *are*
  verified, both by making electron-builder fail on purpose: it rejects the identity
  spelling `security find-identity` prints, and it ad-hoc signs and exits zero when it
  cannot find the identity it was given, which is why the packaging reads the signature
  back off the bundle afterwards. Both warnings are documented rather than left to be discovered, in `docs/install.md` and in the notes
  every release carries, with what each warning does and does not mean and the exact
  way past it. A published checksum is the substitute for the integrity half of a
  signature. There is no substitute for the identity half: a colleague's confidence
  that the file is teamree rests on where they got the link, not on anything the
  operating system can tell them. One half of the macOS instructions is now checked
  rather than asserted: `npm run install:verify` reads the quarantine command out of
  `docs/install.md`, installs a real packaged bundle at the path the document names,
  quarantines it both ways a download arrives and runs that command verbatim. It is a
  command a maintainer runs by hand, deliberately outside the release sequence because
  it writes into `/Applications` — and, correcting what this entry used to say, one
  that has never yet completed. The pipeline was believed to have run it on the macOS
  leg while there was one, but the script died there on an unimported `existsSync`; its
  first half, which compares the document against the release notes and stops before
  the bundle on anything that is not a Mac, exits 0, and exiting 0 was read as a pass.
  The import is fixed and the macOS half is waiting for the first Mac to run it. The other half is not checked. The dialogs, the **Open Anyway**
  route through System Settings and the macOS-version differences around it are
  written from Apple's behaviour and the ad-hoc signing the build already does, and
  have not been walked through on a Mac at this commit.
- **A `git pull` is noticed, but not always at once.** This entry used to say nothing
  re-read `.teamree` at all, and that is no longer true. Each project gets a
  non-recursive watch on its checkout root, on `.teamree` and on `.teamree/members`,
  with a sweep underneath it — the same three `stat`s on a timer, 200ms after a watch
  is attached and backing off to once every thirty seconds — so a dropped event means
  noticing late rather than never. Opening the Start teamwork panel re-reads both
  files as well. What is left of the gap is the bound: a pull the watch misses is up
  to half a minute late, and `docs/trying-teamwork.md` step 5 says so rather than
  promising it is instant. The watch's own tests fail on macOS and have
  never failed on Linux, and why has not been established on a Mac:
  `src/main/teamwork/macWatchProbe.test.ts` answers it outright, under
  `TEAMREE_MAC_PROBE=1`, when somebody can run it.
- **The team-wide fact has a button now.** This entry used to say the relay URL was a
  file whose format had to be inferred, with the helper that would write it exported
  and called by nothing. `teamwork.setRelay` writes `.teamree/relay` from the Start
  teamwork panel's third step, which also lists the four ways to get a relay with what
  each costs and which of them produce an address stable enough to commit. The
  `https://` a deploy prints is still refused rather than guessed at — so is a
  `wss://` origin with no path — but the refusal now offers the corrected URL as a
  button instead of naming only the scheme.
- **Two silent failures look identical, for the first hour.** A clock far enough out to
  straddle the hourly rendezvous boundary and a teammate pointing at a different relay
  both present as nobody arriving, with nothing anywhere saying why. The relay cannot
  help — it sees opaque tokens by design. Narrowed rather than closed: a link that has
  waited across two epoch rollovers now names the two things checkable from this side,
  in the header's tooltip and in the panel's link row. Before then it says only that
  nobody has answered, deliberately, because a colleague making coffee accounts for
  the first hour — so the first hour of this failure still looks like the ordinary
  wait.
- **A path is stored two ways.** A project's path is canonical — resolved, with its
  separators normalised — and a worktree's is joined the host's way, so on Windows the
  same location is spelled `C:/x/y` in one record and `C:\x\y` in another. Nothing is
  known to break: every comparison goes through `pathKey`/`samePath`, which normalises
  first, and git prints forward slashes on every platform regardless. It is recorded
  because two spellings of one thing in one data model is how a later comparison gets
  written without them, and because it was found by a test asserting equality rather
  than by anything going wrong.
- **Windows behaviour is reasoned, not observed.** Narrower than it was, and not
  closed. Command-line encoding is now checked exhaustively rather than by example:
  every argument up to four characters over the alphabet that drives the rules, and
  every pair of arguments up to two, round-trips through a reference
  `CommandLineToArgvW` parser, and the `cmd.exe` tail is checked against cmd's
  documented `/S` rule. That proves the encoder agrees with the parsers it is written
  for. It does not prove a live ConPTY agrees with either, because there is no
  Windows here to ask. The process-tree kill is still untested on Windows: taskkill
  is driven through an injected host, so the decisions around it are asserted, but no
  real taskkill has ever run. The POSIX equivalent is tested for real. Packaging at
  least fails loudly there now — the afterPack hook refuses a build whose node-pty is
  missing `conpty.node`, `pty.node`, `winpty.dll`, `winpty-agent.exe` or the bundled
  ConPTY sidecar, rather than shipping an app whose first terminal never opens.
- **The Windows CLI launcher is a batch shim**, not a native executable.
- **A chatty command keeps its tail on POSIX; Windows is unproven.** The loss was
  node-pty's reader stopping short of the end: the `tty.ReadStream` over the pty
  reports end-of-stream while bytes the child already wrote are still in the
  kernel, and node-pty then closes the descriptor — from its own close handling,
  or from the 200ms timer it arms when the child is reaped — taking those bytes
  with it. The session now reads that descriptor to its real end in the moment
  before the close, so on POSIX nothing is outstanding by the time exit is
  reported, which is the invariant `teamree terminal run` hands an agent. Measured
  here on a 3000-line command: 24 runs in 60 lost the tail before, 0 in 200 after;
  on four cores kept busy, 52 in 60 before and 0 in 60 after. Windows still has
  only the older mitigation — exit held until the output goes quiet — because
  ConPTY output arrives over a pipe node-pty owns rather than a descriptor we can
  read, and nothing has been observed there either way.

## Milestone 2 — Teamwork

Planned in full, with every decision made and written down, in
[docs/teamwork.md](docs/teamwork.md). The short version: the people who can push
to the repository are the team, their public keys live in the repository, an
untrusted relay the team hosts splices two outbound WebSockets together, and
everything across it is end-to-end encrypted. A teammate is a third transport
onto the method catalogue that already exists, not a new protocol.

- [x] **A — Identity, with no network at all.** Keypair, `.teamree/members/`,
      members shown in the app. The whole trust model, testable offline.
  - [x] A member file has to be named exactly `<handle>.pub`. It was matched
        case-insensitively at the suffix and case-sensitively at the stem, so
        `bob.PUB` was accepted as a fully authorised member named "bob" — which
        made attribution forgeable by anyone with push access, and attribution
        is the whole mitigation for a feature that grants remote code execution
  - [x] A public key whose ignored top bit is set is refused: X25519 masks it,
        so `K` and `K | 2^255` are one identity with two spellings, and every
        comparison here is on the spelling
  - [x] Text quoted out of a committed file into a member problem is flattened
        and capped before it reaches a window
- [x] **B — The relay, and presence.** Outbound connections, the Noise `IK`
      handshake against keys from the roster, teammates' worktrees in the
      sidebar. No terminal output yet.
  - [x] The relay URL is committed to the repository at `.teamree/relay`,
        beside the member keys, because a relay is a team-wide fact and a
        second place to keep it is a second place for it to go stale.
        `TEAMREE_RELAY_URL` overrides it for one run, for a tunnel nobody
        should commit. There is deliberately no default
  - [x] A rendezvous per teammate **per repository**, derived from the
        static-static Diffie-Hellman, the project and the hour, with the token
        in the first frame and only its hash in the URL. This diverges from
        `relay/README.md`, which specifies one pairwise rendezvous for all
        time: a pairwise session is one indistinguishable shape across every
        repository two people share, with nothing in its transcript saying
        which project it is for. The relay needs no change either way
  - [x] Noise `IK` over the splice, against the one key this link dialled,
        with a prologue that is never empty and carries the project and the
        pairing. Every way the handshake can fail ends the connection
        identically, so "not a member" and "wrong machine" are one answer on
        the wire and two in this machine's own log
  - [x] Completing a handshake is not evidence anybody is there: a responder
        finishes `IK` having only written its own message, so a replayed
        message 1 reaches `established` carrying the real peer's key. A link
        says `connected`, subscribes, and believes a snapshot only after the
        first transport message from the far end that decrypts — which needs
        keys a recording cannot supply
  - [x] A teammate is a third transport onto the existing catalogue, beside
        Electron IPC and the CLI socket, speaking
        the same newline-delimited JSON the CLI socket does — so the dispatcher,
        the subscription hub and every handler are unchanged. What a teammate
        may call is one explicit list, and it is presence and nothing else
  - [x] Worktrees, branches and per-pane activity cross as metadata. Silence
        crosses as a duration rather than an instant, because two machines do
        not agree about what time it is
  - [x] A project is matched across machines by a hash of its origin remote, so
        a teammate on one repository learns nothing about the others a pairwise
        link happens to span. The roster is filtered on both sides
  - [x] Teammates' worktrees under the same project in the sidebar, visibly
        theirs, with nothing on them to act on
  - [x] Connecting, connected, refused, relay-unreachable and "nobody is
        connected" are five separate things the header says separately —
        "not set up here" loudest of all, because it is the ordinary one
  - [x] Tested against the relay itself: the built container host, as a child
        process, on a real port, over real WebSockets, between two runtimes with
        their own data directories and their own identities
- [x] **C — Watching a pane.** `terminal.subscribe` over the peer transport,
      read-only, letterboxed to the owner's dimensions, and the pane says it is
      being watched.
  - [x] The allow-list widened by exactly two methods, both reads:
        `terminal.read` for the scrollback a watcher joins at and
        `terminal.subscribe` for everything after it. `terminal.write`,
        `terminal.resize` and `terminal.close` stay absent, and that absence is
        the whole of what makes watching read-only — a watcher's keystroke
        reaches a method the far runtime does not admit to having. Neither the
        terminal service nor the dispatcher was touched
  - [x] Bytes flow only for a pane somebody has open and stop when they close
        it, because ten people streaming forty panes at each other is N²
        bandwidth for output nobody is reading
  - [x] The join between the scrollback and the live tail, with neither a gap
        nor a duplicated overlap, and with no byte arithmetic: the subscribe
        goes first, everything the stream says is held until the read's answer
        lands, and the held output is then cut at the answer's own position in
        the received frame order — the overlap the snapshot already carries is
        dropped, the live tail behind it is written out. An exit and a title
        survive wherever they sat, because a scrollback holds neither
  - [x] And that position is the answer's frame, not the moment its promise
        settles. The two are different moments: one socket read decodes a batch
        and the transport routes it synchronously, so frames behind the answer
        — in nobody's scrollback — reach the reader before the continuation
        after `await` runs, and a join that discarded by that clock threw live
        output away silently, the more of it the busier the machine. Found by
        hammering the relay test under load rather than calling it flaky. The
        owner's side keeps the other half of the bargain: a read flushes its
        pane's paced output before the answer, so nothing the answer contains
        can overtake it on the wire
  - [x] The owner's dimensions cross as metadata and a watcher letterboxes to
        them. There is no method through which a reader could change them
  - [x] A pane that outruns the relay's 200 frames and 4 MiB a second is
        coalesced first, which is lossless, and only then trimmed — and when it
        is trimmed the watcher is told how many bytes went, in the stream,
        where the hole is. Output dropped silently would make the view a lie
  - [x] A watch that ends for a reason the reader cannot see says so: the owner
        closing the pane, the pane exiting, and the link dropping are three
        notices rather than a window that quietly stops updating
  - [x] The owner sees who is reading each of their panes, by name and live,
        because the design's case for why "anyone can type" is survivable is
        that none of it can be done invisibly
  - [x] Tested against the relay itself again, with real PTYs behind it: two
        watchers on one pane, the owner watching their own pane while a
        teammate does, the pane exiting under a watcher, the owner closing it
        under a watcher, and the link dropping mid-stream and coming back
- [x] **D — Typing into a pane.** `terminal.write` over the same transport, with
      live attribution, a local audit log, and per-pane mute. The milestone that
      needs the most care: it is the one that hands somebody else a shell.
  - [x] The allow-list widened by exactly one method, and it is the only one on
        it that changes anything. `terminal.resize` and `terminal.close` stay
        absent — a teammate's window is not this pane's window and their
        keyboard is not its power switch — and so does everything touching git.
        Neither the terminal service nor the dispatcher was touched
  - [x] Being on the list is not the same as being allowed: every keystroke
        passes a verdict from the thing that knows whose link it arrived on,
        and a transport wired without one carries no keystrokes at all. A byte
        reaching a pty that nobody can attribute is the one outcome this
        milestone exists to make unreachable
  - [x] Attribution is live and is updated before the write is dispatched, in
        memory, where it cannot fail. The pane names whoever is typing while
        they type, and goes on saying they typed here after they stop, because
        a pane a teammate has run commands in is not a pane whose history is
        the owner's alone
  - [x] **The audit log holds who, when, which pane, how many bytes, how many
        submissions, and whether it landed — and never the bytes.** A remote
        write carries input, and input includes what a program deliberately
        does not echo; keeping it would build a plaintext store of teammates'
        passphrases out of a safety feature, and would hold strictly more than
        the screen the owner can already read. Refusals are recorded too:
        somebody still typing at a muted pane is the thing an owner most wants
        to know. It is JSON Lines beside the identity, rotated once at a cap,
        and it survives a restart because a record that did not would not be one
  - [x] Mute is the owner's, per-pane, and instant: no round trip, no
        agreement, and no way for a teammate to refuse it. It is checked in the
        same task that dispatches the write with nothing awaited in between, so
        a keystroke still in flight when the mute lands is refused rather than
        run. A muted pane keeps streaming and keeps its row — mute stops the
        bytes, it does not hide the worktree
  - [x] Nothing is dropped in silence. A refusal is answered with the owner's
        own words and drawn in the pane where the keystroke would have gone, so
        a mute, a pane that exited and a link that went are three sentences
        rather than a keyboard that quietly stopped working
  - [x] One write is capped below the relay's per-second byte budget, refused
        whole rather than chunked: half a paste landing in somebody's shell is
        worse than none of it
  - [x] A message that arrives over a session refused while that same message
        was being read runs nothing from it. Key confirmation can tear the link
        down mid-message, and a keystroke behind it must not run merely because
        the loop had already started
  - [x] Tested against the relay itself again, with real PTYs behind it: a
        keystroke landing and coming back out of the pty, the owner muting
        mid-stream, a muted pane still streaming and still in the sidebar, two
        teammates typing at once, a pane whose process has exited, a link that
        went while a keystroke travelled, and a key taken off the roster
- [x] **E — Staleness.** The local cache, stale marking with its age, and

      reconnection that reconciles rather than re-fetching the world.
  - [x] A teammate's worktrees stay in the sidebar when their machine goes,
        marked away and dated. A row vanishing reads as a worktree deleted,
        which is the one thing this app must never wrongly say
  - [x] The cache is a file beside the workspace, not a section inside it:
        presence moves whenever a pane goes busy, and bytes another machine
        sent have no business in the file holding somebody's projects
  - [x] Offline, removed and never-seen are three shapes rather than three
        readings of one. A snapshot is the whole of what a teammate has, so a
        worktree missing from the newest one stops being shown; a teammate with
        no snapshot at all is named as unheard instead of drawn as having
        nothing
  - [x] A cached row can never be read as a live one: `live` needs both a frame
        that decrypted on this session and that session still being up, and the
        revision a snapshot was heard at is dropped with the session, so a peer
        that restarted at revision 1 is not mistaken for a late reply
  - [x] Everything from a peer is bounded — worktrees, panes, string lengths,
        teammates held, and the age past which a picture stops being one — and
        bounded again when it is read back, whatever wrote the file
  - [x] Reconnection reconciles: the rows on screen are never rebuilt from
        nothing, so the sidebar does not flash empty on the way to being right
- [x] **F — The owner's consent.** A teammate's keystroke is held on the owner's
      machine until the owner has been shown it and has answered. This reverses
      the decision D shipped, deliberately and on request: D's argument — that a
      permission model is a lie when everyone who can push can already run
      anything — is about a hostile member, and the ordinary case is not
      hostility but surprise. A colleague answering a prompt that has moved on
      still runs as you
  - [x] `held` is a third verdict beside yes and no, and it is a promise. The
        request never reaches the dispatcher while it is unsettled, so a held
        keystroke has not happened to the pane in any sense; when it settles,
        an allowed one goes through the *whole* judgment again — roster, pane,
        mute — because consent is permission to run and never a way round the
        rest. The teammate's own call stays open across the wait, which is why
        `terminal.write` alone carries a longer deadline than everything else
  - [x] The owner is shown who, which pane, and the bytes — rendered so every
        control character is visible and none can act. An escape sequence is
        printed rather than obeyed, a return is a mark, and the characters that
        reverse or hide text are named. The person being asked about does not
        get to paint the question they are being asked about
  - [x] **Allow once means what the owner was shown.** A burst grows while the
        prompt is up, so the answer carries the count that was on the screen
        that was read; what arrived after it stays held and asks again
  - [x] A burst is one question and never one per keystroke. Nine prompts for
        `npm test` would be a prompt nobody reads, and a prompt nobody reads is
        worse than no prompt — it trains people to click through
  - [x] Nothing waits forever and nothing vanishes. A request nobody answers
        expires after a minute; allowed, refused, expired and "the link went"
        are four sentences the person who typed is given, and one of them
        always arrives
  - [x] Standing permissions are per teammate per pane. "This session" ends with
        the runtime or the link; "always" is filed beside the mute against the
        pane's own record, so it comes back with the pane and goes when the pane
        does. Both are listed where the mute is, because a permission the owner
        cannot see is one they cannot lift
  - [x] Mute still wins, still instantly, and with no prompt at all — it is that
        question already answered. It also cancels whatever was waiting on that
        pane and lifts every permission on it, because a permission that
        outlived a mute would make the mute last exactly as long as the next
        unmute
  - [x] A pane of a project the asker is not on, and a pane id that names
        nothing, are still answered identically and still answered at once.
        Waiting where a refusal returns would say "this pane exists" as plainly
        as showing it would
  - [x] The same surface on the CLI — `team requests`, `team allow`, `team
        deny`, `team revoke` — because a machine driven headlessly must be able
        to answer, or its teammates simply hang for a minute
  - [x] Tested against the relay itself with real PTYs behind it, and in the
        two-machine scenario: the request waiting with the agent still blocked,
        the allow releasing it, a standing permission surviving into the next
        keystroke, and a mute answering both of them without asking

## Later

Graph-based unified memory. Per-person attribution of work under a shared
project.
