# Permission mode in the New Task dialog

## Problem

Agents started from New Task launch with whatever their own config says, plus the per-agent arguments in
Settings. Choosing between "ask me", "auto" and "skip every prompt" means editing Settings, and the choice
is then invisible at the moment it matters: when the task starts.

## What exists today

- `startTask` (`src/renderer/src/state/workspaceStore.ts`) calls `terminal.create` with the agent's
  `command` and `agentArgs`, the per-kind string from Settings (`teamree.agent.args`).
- `agentLaunchCommand` (`src/shared/agentLaunch.ts`) joins them; `terminals/agent-command.ts` then adds
  the session selector and the first prompt. Resume keeps the stored line, so the mode survives a restart.
- Nothing passes a permission flag. `preferences.ts` ships `agentArgs` empty on purpose.

## Verified flags (on this machine, 2026-09-26)

| Harness | Version | Default | Auto | Bypass |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.282 | no flag | `--permission-mode auto` | `--dangerously-skip-permissions` |
| Codex | codex-cli 0.146.0 | no flag | `--sandbox workspace-write --ask-for-approval on-request` | `--dangerously-bypass-approvals-and-sandbox` |

- Claude `--permission-mode` choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`.
- Codex 0.146 no longer accepts `--full-auto`; Auto is what it expanded to.
- Default passes nothing, so the agent's own config (Claude `defaultMode`, Codex `config.toml`) still decides.
- Other harnesses are not installed here, so their flags cannot be checked; they get no control and no flag.

## UX

- Inline in each Agents row, shown only when that agent's count is above zero and the harness has modes:
  `Claude Code   − 1 +   [Default | Auto | Bypass]`.
- A segmented radio group (buttons with `role="radio"`), not a confirm step: the choice is on screen every
  time Start is pressed, and a second step would break Enter / Cmd+Enter.
- Bypass, when selected, is drawn in the danger colour. Labels are one word; the flag is the tooltip.
- Remembered per project and per harness (`teamree.agent.permissionModes`), written on Start, not on click,
  so a Bypass tried and cancelled is not what the next task opens with.
- Nothing remembered means Default: seeding a dangerous mode stays a choice the person makes.

## Implementation

1. `src/shared/permissionMode.ts`: `PermissionMode`, `permissionModesFor(kind)`, `permissionArgs(kind, mode)`.
2. `taskPlan.ts`: `taskCreates` takes the chosen modes and puts `permissionArgs` on each create.
3. `startTask`: `command` becomes `agentLaunchCommand(agentCommand, permissionArgs)`; Settings arguments
   still go in `agentArgs`, after it.
4. `preferences.ts` + store: read, write and remember the modes per project.
5. `AgentSteppers`: optional `modes` / `onMode` props render the segmented control.
6. Tests: `permissionArgs` for every mode and an unknown harness; `taskCreates` carries the flags; the dialog
   shows the control only for selected harnesses and remembers the choice on Start.
