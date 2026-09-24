// What can start in a worktree: fixed rows, then the agents the runtime's probe found, in its order.
// The strip's `+` shows them as a menu, an empty worktree as buttons.

import type { InstalledAgent } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import type { RowMenuItem } from '../sidebar/RowMenu'
import { useWorkspaceStore } from '../state/workspaceStore'

/** What choosing a row does; the strip binds each to the store. */
export type StartMenuActions = {
  newTerminal: () => void
  newMarkdown: () => void
  startAgent: (command: string) => void
  openAgentSettings: () => void
}

type FixedRow = {
  label: string
  /** The command whose chord the row shows beside it, when it has one. */
  command?: WorkspaceCommand
  icon: React.ReactNode
  run: (actions: StartMenuActions) => void
  /** Opens no pane, so an empty worktree's buttons leave it out. */
  menuOnly?: boolean
}

/** A group of fixed rows, or the installed agents, one row each. */
type StartMenuGroup = readonly FixedRow[] | 'agents'

/** The menu, top to bottom, a rule between groups. A new pane kind goes in the first group. */
export const MENU_ROWS: readonly StartMenuGroup[] = [
  [
    {
      label: 'New Terminal',
      command: 'new-terminal',
      icon: <TerminalGlyph />,
      run: (actions) => actions.newTerminal()
    },
    {
      label: 'New Markdown',
      command: 'new-markdown',
      icon: <PageGlyph />,
      run: (actions) => actions.newMarkdown()
    }
  ],
  'agents',
  [
    {
      label: 'Agent Settings…',
      icon: <SettingsGlyph />,
      run: (actions) => actions.openAgentSettings(),
      menuOnly: true
    }
  ]
]

export function startMenuItems(
  agents: readonly InstalledAgent[],
  modifier: PlatformModifier,
  actions: StartMenuActions,
  panesOnly = false
): RowMenuItem[] {
  const items: RowMenuItem[] = []
  for (const group of MENU_ROWS) {
    const rows: RowMenuItem[] =
      group === 'agents'
        ? agents.map((agent) => ({
            label: harnessName(agent.kind),
            icon: <AgentGlyph kind={agent.kind} />,
            onChoose: () => actions.startAgent(agent.command)
          }))
        : group
            .filter((row) => !(panesOnly && row.menuOnly === true))
            .map((row) => ({
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

/** The rows bound to the store, for the worktree given; none without one. */
export function useStartMenuItems(
  worktreeId: string | null,
  modifier: PlatformModifier,
  panesOnly = false
): RowMenuItem[] {
  const agents = useWorkspaceStore((state) => state.agents)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const newMarkdown = useWorkspaceStore((state) => state.newMarkdown)
  const startAgent = useWorkspaceStore((state) => state.startAgent)
  const openSettings = useWorkspaceStore((state) => state.openSettings)
  if (worktreeId === null) return []
  return startMenuItems(
    agents,
    modifier,
    {
      newTerminal: () => void createTerminal(worktreeId),
      newMarkdown: () => newMarkdown(worktreeId),
      startAgent: (command) => void startAgent(command),
      openAgentSettings: () => openSettings('agents')
    },
    panesOnly
  )
}

function TerminalGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1.5 2.5 H10.5 V9.5 H1.5 Z M3.5 4.8 L5.3 6.2 L3.5 7.6 M6.3 7.6 H8.5" />
    </svg>
  )
}

function PageGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 1.5 H7.5 L10 4 V10.5 H3 Z M7.5 1.5 V4 H10 M4.5 6.5 H8.5 M4.5 8.5 H8.5" />
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
