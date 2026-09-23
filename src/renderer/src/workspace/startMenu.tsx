// What the strip's `+` offers: everything that can be started in the worktree
// on screen. The fixed rows are listed here; the agents are whatever the
// runtime's probe found, in its order, so a machine without one gets no row
// for it rather than a row that fails.

import type { InstalledAgent } from '@shared/entities'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import type { RowMenuItem } from '../sidebar/RowMenu'

/** What choosing a row does; the strip binds each to the store. */
export type StartMenuActions = {
  newTerminal: () => void
  startAgent: (command: string) => void
  openAgentSettings: () => void
}

type FixedRow = {
  label: string
  /** The command whose chord the row shows beside it, when it has one. */
  command?: WorkspaceCommand
  icon: React.ReactNode
  run: (actions: StartMenuActions) => void
}

/** A group of fixed rows, or the installed agents, one row each. */
type StartMenuGroup = readonly FixedRow[] | 'agents'

/** The menu, top to bottom, a rule between groups. A new pane kind goes in the first group. */
export const MENU_ROWS: readonly StartMenuGroup[] = [
  [
    {
      label: 'New terminal',
      command: 'new-terminal',
      icon: <TerminalGlyph />,
      run: (actions) => actions.newTerminal()
    }
  ],
  'agents',
  [
    {
      label: 'Agent settings…',
      icon: <SettingsGlyph />,
      run: (actions) => actions.openAgentSettings()
    }
  ]
]

export function startMenuItems(
  agents: readonly InstalledAgent[],
  modifier: PlatformModifier,
  actions: StartMenuActions
): RowMenuItem[] {
  const items: RowMenuItem[] = []
  for (const group of MENU_ROWS) {
    const rows: RowMenuItem[] =
      group === 'agents'
        ? agents.map((agent) => ({
            label: agent.command,
            icon: <AgentGlyph />,
            onChoose: () => actions.startAgent(agent.command)
          }))
        : group.map((row) => ({
            label: row.label,
            icon: row.icon,
            ...(row.command === undefined ? {} : { hint: shortcutHint(row.command, modifier) }),
            onChoose: () => row.run(actions)
          }))
    const first = rows[0]
    if (first !== undefined && items.length > 0) rows[0] = { ...first, separated: true }
    items.push(...rows)
  }
  return items
}

function TerminalGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1.5 2.5 H10.5 V9.5 H1.5 Z M3.5 4.8 L5.3 6.2 L3.5 7.6 M6.3 7.6 H8.5" />
    </svg>
  )
}

/** Neutral on purpose: the app draws no agent by a mark of its own yet. */
function AgentGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.5 L7.1 4.9 L10.5 6 L7.1 7.1 L6 10.5 L4.9 7.1 L1.5 6 L4.9 4.9 Z" />
    </svg>
  )
}

function SettingsGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 4.2 A1.8 1.8 0 1 0 6 7.8 A1.8 1.8 0 1 0 6 4.2 M6 1.5 V3 M6 9 V10.5 M1.5 6 H3 M9 6 H10.5 M2.8 2.8 L3.9 3.9 M8.1 8.1 L9.2 9.2 M2.8 9.2 L3.9 8.1 M8.1 3.9 L9.2 2.8" />
    </svg>
  )
}
