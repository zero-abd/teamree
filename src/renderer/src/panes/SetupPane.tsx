// A new worktree's setup as its pane draws it: one line saying what runs while it runs, the output only
// when asked for, and after a failure the way on without it.

import type { Terminal } from '@shared/entities'
import { SETTING_UP } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Button } from '../ui/Button'
import { StatusDot } from '../ui/StatusPill'

/** Over a running setup pane: `Setting up · <command>`, and its output on demand. */
export function SetupRunning({
  terminal,
  output,
  onToggle
}: {
  terminal: Terminal
  output: boolean
  onToggle: () => void
}): React.JSX.Element {
  const command = terminal.command ?? terminal.title
  return (
    <div className="pane-state" role="status" aria-label={`${SETTING_UP} · ${command}`}>
      <span className="pane-state__dot pane-foot__dot--breathing">
        <StatusDot state="working" />
      </span>
      <span className="pane-state__body">
        <span className="pane-state__title">{SETTING_UP}</span>
        <span className="pane-state__meta">{command}</span>
      </span>
      <span className="pane-state__actions">
        <Button variant="ghost" size="sm" aria-expanded={output} onClick={onToggle}>
          {output ? 'Hide Output' : 'Show Output'}
        </Button>
      </span>
    </div>
  )
}

/** A setup's end block after Run Again: the agent its task held back, and a shell to put things right in. */
export function useSetupEndActions(terminal: Terminal | undefined): Array<{ label: string; run: () => void }> {
  const worktreeId = terminal?.worktreeId ?? ''
  const held = useWorkspaceStore((state) => state.setupHolds[worktreeId] !== undefined)
  const startHeldAgent = useWorkspaceStore((state) => state.startHeldAgent)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  if (terminal?.run !== 'setup') return []
  return [
    ...(held ? [{ label: 'Start Agent Anyway', run: () => void startHeldAgent(worktreeId) }] : []),
    { label: 'Open Shell', run: () => void createTerminal(worktreeId) }
  ]
}
