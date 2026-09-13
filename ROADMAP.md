# Roadmap

Milestone 1 is single-user and is the current target. Team features come after it works.

## Stack

- TypeScript end to end
- Electron for the shell, so terminal rendering behaves the same on every platform
- React + Vite for the renderer
- A runtime owning git, worktrees, terminals, and state
- One contract in `src/shared` typing the runtime, the GUI, and the CLI from a single declaration
- A `teamree` CLI over a local socket, so a coding agent can drive the app

## Architecture

Three consumers, one contract. The renderer reaches the runtime over Electron IPC through
an isolated preload bridge. The CLI reaches the same runtime over a unix socket, or a named
pipe on Windows, speaking newline-delimited JSON. Both are typed from `src/shared/methods.ts`,
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

## Known gaps

Milestone 1 is complete and verified. These are the honest limits of what it does,
recorded so none of them is discovered by surprise later.

- **A restarted shell is a fresh shell.** Panes and their directories come back, and
  an agent pane comes back with its conversation (see M10), but an ordinary pane's
  scrollback and whatever it was running are gone: the PTY died with the app. A
  command is never re-issued unless it resumes something, so a pane left on a deploy
  or a migration comes back as a shell rather than running it twice. Keeping the
  process itself alive would mean moving PTYs into a daemon that outlives the app.
- **Only macOS has been packaged and launched.** The Windows installer needs Windows or
  wine; Linux cannot be packaged off Linux because node-pty has no Linux prebuild and
  must be compiled. Both are configured, and a three-runner CI workflow exists but has
  never been run.
- **Windows behaviour is reasoned, not observed.** Command-line encoding is proved
  against a reference `CommandLineToArgvW` parser rather than a live ConPTY, and the
  process-tree kill is untested there. The POSIX equivalent is tested for real.
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

- [ ] **A — Identity, with no network at all.** Keypair, `.teamree/members/`,
      members shown in the app. The whole trust model, testable offline.
- [ ] **B — The relay, and presence.** Outbound connections, the Noise `IK`
      handshake against keys from the roster, teammates' worktrees in the
      sidebar. No terminal output yet.
- [ ] **C — Watching a pane.** `terminal.subscribe` over the peer transport,
      read-only, letterboxed to the owner's dimensions, and the pane says it is
      being watched.
- [ ] **D — Typing into a pane.** `terminal.write` over the same transport, with
      live attribution, a local audit log, and per-pane mute. The milestone that
      needs the most care: it is the one that hands somebody else a shell.
- [ ] **E — Staleness.** The local cache, stale marking with its age, and
      reconnection that reconciles rather than re-fetching the world.

## Later

Graph-based unified memory. Per-person attribution of work under a shared
project.
