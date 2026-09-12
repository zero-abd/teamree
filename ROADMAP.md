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
- [ ] Start-from picker: base ref, local branch, commit, remote branch
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
- [ ] GUI consumes the stream and drops its poll loop
- [x] `teamree worktree wait`, `teamree terminal wait`, and `teamree terminal run` for agents

## M6 — Acceptance

- [x] End-to-end: create a worktree, open a terminal, run a command, read the output back
- [x] The same flow driven entirely through the CLI
- [x] macOS, Linux, Windows path and process handling
- [x] Packaged build

## Later

Graph-based unified memory. Multi-user networking. Per-person attribution of work
under a shared project.
