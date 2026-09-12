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
- [x] `teamree worktree merges`
- [x] The answer shown per worktree in the sidebar, capped at four reads in
      flight so a refresh cannot fan out a git process per row

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
- **A very chatty command can lose the tail of its output.** node-pty destroys the
  pty socket 200ms after the child is reaped, and whatever is still unread at that
  moment is discarded before the runtime sees it. The session holds its own exit
  event until the data goes quiet, so "exited" still means "and everything that
  reached us is readable" — but it cannot recover what was already dropped.
  Measured on an idle machine: 1000 lines of output always arrive intact, 3000
  lose the tail about one run in five, and a loaded machine does worse. It matters
  most for `teamree terminal run`, where the last lines are usually the ones an
  agent wants. Fixing it properly means reading the pty ourselves rather than
  through node-pty's socket.

## Later

Graph-based unified memory. Multi-user networking. Per-person attribution of work
under a shared project.
