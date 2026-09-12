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
- [ ] Method registry, dispatcher, structured errors
- [ ] Local socket server with runtime discovery
- [ ] Subscription manager for streaming output
- [ ] Durable store for projects, worktrees, layouts

## M2 — Repos and worktrees

- [ ] Add and track a repo
- [ ] List worktrees, reconciled against real git state
- [ ] Create a worktree in the background with progress and failure recovery
- [ ] Start-from picker: base ref, local branch, commit, remote branch
- [ ] Live git status per worktree
- [ ] Delete a worktree and optionally its branch

## M3 — Terminals

- [ ] PTY sessions with a correct per-platform environment
- [ ] Bounded scrollback, readable as a snapshot
- [ ] Streaming output, title detection from escape sequences
- [ ] Split panes, arbitrarily nested, resizable
- [ ] Process-tree cleanup so nothing is orphaned

## M4 — GUI

- [ ] App shell: sidebar, main area, status bar
- [ ] Projects and worktrees in the sidebar with live status
- [ ] Create-worktree flow that does not block
- [ ] Terminal panes rendering the split tree
- [ ] Keyboard shortcuts with correct per-platform modifiers

## M5 — CLI

- [ ] Transport, discovery, and exit codes that mean something
- [ ] `teamree status`
- [ ] `teamree project` and `teamree worktree`
- [ ] `teamree terminal` including read, send, and split
- [ ] `--json` on every command

## M6 — Acceptance

- [ ] End-to-end: create a worktree, open a terminal, run a command, read the output back
- [ ] The same flow driven entirely through the CLI
- [ ] macOS, Linux, Windows path and process handling
- [ ] Packaged build

## Later

Graph-based unified memory. Multi-user networking. Per-person attribution of work
under a shared project.
