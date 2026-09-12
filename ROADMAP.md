# Roadmap

Milestone 1 is single-user. Team features are deliberately out of scope until it works.

## Stack

- TypeScript end to end
- Electron for the shell, one Chromium on every platform
- React + Vite for the renderer
- A runtime process owning git, worktrees, and state
- A detached terminal daemon owning every PTY
- A `teamree` CLI speaking the same protocol as the GUI

## M0 — Scaffold

- [x] Electron + Vite + React + TypeScript builds and launches
- [x] Main, preload, renderer split with strict process boundaries
- [x] Typecheck, lint, format, test wired up

## M1 — Runtime and RPC

- [ ] Method registry pairing a Zod schema with a handler
- [ ] Single dispatcher boundary, typed results, structured errors
- [ ] Local socket server (unix socket, named pipe on Windows)
- [ ] Renderer client over preload; same protocol as the CLI

## M2 — Repos and worktrees

- [ ] Add and track a repo
- [ ] List worktrees with live git status
- [ ] Create a worktree in the background with progress and cancel
- [ ] Start-from picker: base ref, local branch, commit, remote branch
- [ ] Materialize gitignored paths into new worktrees
- [ ] Delete a worktree and its branch, with confirmation

## M3 — Terminals

- [ ] PTY spawn with correct env per platform
- [ ] Terminal daemon detached from the app, survives restart
- [ ] xterm.js rendering with WebGL
- [ ] Splits, arbitrary nesting
- [ ] Scrollback that survives a restart

## M4 — GUI shell

- [ ] Sidebar: projects and their worktrees
- [ ] Tab bar and pane layout
- [ ] Terminal panes scoped to a worktree
- [ ] Status bar
- [ ] Quick open

## M5 — CLI

- [ ] `teamree status`
- [ ] `teamree worktree` list, create, remove, current
- [ ] `teamree terminal` list, read, send, create, split, wait
- [ ] JSON output on every command

## M6 — Hardening

- [ ] Session restore on launch
- [ ] macOS, Linux, Windows paths and process handling
- [ ] Packaging and a signed build

## Later

Graph-based unified memory. Multi-user networking. Per-person attribution of work under a shared project.
