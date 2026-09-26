# Subagents in the sidebar

A Claude Code session in a teamree pane that starts subagents (the `Agent`
tool) shows each running one as a child row under that pane: description,
elapsed time. Clicking a child opens its transcript, read-only.

## Scope

Only sessions teamree launched. A pane knows its Claude Code session because
teamree pins it at launch (`claude --session-id <id>`) and its `SessionStart`
hook reports the id it actually runs under (a `/clear` or a resume can change
it). The tracker reads only `<store>/projects/<slug of the pane cwd>/<id>/`
for those ids. Sessions started outside teamree, in a terminal or an IDE, are
never read and never shown, even when they share the pane's directory.

## Signals, as verified on Claude Code 2.1.282

| Signal | What it carries | Verdict |
| --- | --- | --- |
| `SubagentStart` hook | `session_id`, `agent_id`, `agent_type`, parent `transcript_path`; no description | Primary: start, instantly |
| `SubagentStop` hook | `agent_id`, `agent_transcript_path`, `last_assistant_message` | Primary: stop, instantly; no success/failure field |
| `SessionStart` hook | `session_id`, `source` (`startup`, `resume`, …) | Adds the pane's live session id |
| `<id>/subagents/agent-<agentId>.meta.json` | `agentType`, `description`, `toolUseId`, `parentAgentId`, `spawnDepth`, `requestShape`, `worktreePath`, `worktreeBranch` | Fallback: every subagent, nested ones included, flat in one directory |
| `<id>/subagents/agent-<agentId>.jsonl` | The subagent's transcript | What the click shows; its mtime is the last activity |
| `<task-notification>` in the parent's transcript | `<task-id>`, `<status>` `completed`/`failed`/`killed` | Fallback end state for background agents; a nested agent's lands in its parent agent's transcript |
| `tool_result` for the meta's `toolUseId` | `is_error` | Fallback end state for foreground agents |
| `/private/tmp/claude-<uid>/<slug>/<id>/tasks/<agentId>.output` | Symlink to the subagent's `.jsonl` | Not used: a duplicate of the transcript |
| `git worktree list` for isolated agents (`.claude/worktrees/agent-*`) | A worktree per isolated subagent | Not needed: the sidebar lists only worktrees teamree records, so these never appear at the top level; the meta's `worktreePath` and branch go on the child row |

Hooks were checked by running `claude -p --settings <file>` with all three
hooks writing their stdin to a file; the disk layout on a live session.

## Design

- **Hooks.** `agent-hooks.ts` subscribes panes to `SubagentStart` and
  `SubagentStop` as well. `teamree agent event` forwards them to a new
  `terminal.subagentEvent`, and forwards `session_id` on every event.
- **Tracker** (`src/main/terminals/subagents.ts`), owned by the session
  manager. Per Claude pane: the pinned session id plus any reported by a hook.
  It merges hook state with the disk:
  - list `subagents/*.meta.json` for each known session;
  - read each transcript in the session (main and subagents) incrementally,
    appended bytes only, collecting task notifications and tool results;
  - running: no end signal (notification, stop hook, tool result), or a
    start or transcript write after the latest one (a resumed agent); with
    no end signal, only while the pane runs and the agent wrote since the
    pane started.
- **Reconcile.** On tracking a pane (every restored pane at startup) and on a
  2s poll while any Claude pane is open, so an agent created before the app
  started, or a hook that never arrived, is still found. A hook triggers an
  immediate read of that pane.
- **Wire.** `Terminal.subagents` on `terminal.list`; changes emit the
  existing `terminals` workspace event. `terminal.subagentTranscript` returns
  a subagent's transcript as prompt, text and tool lines, capped.
- **Sidebar.** Child rows under the pane row, nested by `parentAgentId`:
  running dot, description, elapsed. Only running subagents are listed; one
  whose parent agent has ended is not running. Click opens the transcript
  dialog, refreshed while the agent runs.

## Not guaranteed

- **Other agents.** Codex, Gemini and the rest have no equivalent here; their
  panes show no children.
- **Sessions outside teamree.** Out of scope; ignored by construction.
- **Format drift.** The meta file, notification text and transcript layout
  are Claude Code internals. Hooks keep start and stop working if they move;
  descriptions would degrade to agent type.
- **Store location.** A pinned session is looked for under the store for the
  pane's directory (honouring `CLAUDE_CONFIG_DIR` as teamree sees it); once a
  hook fires, the transcript path it reports is used instead.
- **A crash without a word.** A subagent that dies leaving no notification or
  tool result reads as running until its pane's agent exits.
- **Claude typed into a shell pane.** Not launched by teamree with a session
  id or hooks, so not followed.
