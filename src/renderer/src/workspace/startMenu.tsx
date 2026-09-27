// What can start in a worktree: fixed rows, then the agents the runtime's probe found, in its order.
// The strip's `+` shows them as a menu, an empty worktree as buttons.

import type { InstalledAgent } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName, hasResumable } from '../agents/harnesses'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import type { RowMenuItem } from '../sidebar/RowMenu'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Icon } from '../icons/Icon'

export const RESUME_CONVERSATION = 'Resume Conversation…'

/** What choosing a row does; the strip binds each to the store. */
export type StartMenuActions = {
  newTerminal: () => void
  newMarkdown: () => void
  startAgent: (command: string) => void
  resumeConversation: () => void
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
  /** Shown only where the worktree has a past conversation to resume. */
  needsHistory?: boolean
}

/** A group of fixed rows, or the installed agents, one row each. */
type StartMenuGroup = readonly FixedRow[] | 'agents'

/** The menu, top to bottom, a rule between groups. A new pane kind goes in the first group. */
export const MENU_ROWS: readonly StartMenuGroup[] = [
  [
    {
      label: 'New Terminal',
      command: 'new-terminal',
      icon: <Icon name="terminal" size={14} />,
      run: (actions) => actions.newTerminal()
    },
    {
      label: 'New Markdown',
      command: 'new-markdown',
      icon: <Icon name="page" size={14} />,
      run: (actions) => actions.newMarkdown()
    }
  ],
  'agents',
  [
    {
      label: RESUME_CONVERSATION,
      icon: <Icon name="history" size={14} />,
      run: (actions) => actions.resumeConversation(),
      needsHistory: true
    },
    {
      label: 'Agent Settings…',
      icon: <Icon name="settings" size={14} />,
      run: (actions) => actions.openAgentSettings(),
      menuOnly: true
    }
  ]
]

export function startMenuItems(
  agents: readonly InstalledAgent[],
  modifier: PlatformModifier,
  actions: StartMenuActions,
  panesOnly = false,
  resumable = false
): RowMenuItem[] {
  const items: RowMenuItem[] = []
  for (const group of MENU_ROWS) {
    const rows: RowMenuItem[] =
      group === 'agents'
        ? agents.map((agent) => ({
            label: harnessName(agent.kind),
            icon: <AgentGlyph kind={agent.kind} decorative />,
            onChoose: () => actions.startAgent(agent.command)
          }))
        : group
            .filter((row) => !(panesOnly && row.menuOnly === true) && (resumable || row.needsHistory !== true))
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
  const conversations = useWorkspaceStore((state) =>
    worktreeId === null ? undefined : state.conversations[worktreeId]
  )
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const newMarkdown = useWorkspaceStore((state) => state.newMarkdown)
  const startAgent = useWorkspaceStore((state) => state.startAgent)
  const openSettings = useWorkspaceStore((state) => state.openSettings)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  if (worktreeId === null) return []
  return startMenuItems(
    agents,
    modifier,
    {
      newTerminal: () => void createTerminal(worktreeId),
      newMarkdown: () => newMarkdown(worktreeId),
      startAgent: (command) => void startAgent(command),
      resumeConversation: () => openDialog({ kind: 'resume-conversation', worktreeId }),
      openAgentSettings: () => openSettings('agents')
    },
    panesOnly,
    hasResumable(conversations, agents)
  )
}
