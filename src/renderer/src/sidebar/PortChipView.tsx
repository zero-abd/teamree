// The row's `:5173` chip: a click opens the lowest port on localhost, the hover lists them all.

import type { Terminal } from '@shared/entities'
import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore } from '../state/workspaceStore'
import { portChip } from './portChip'

export function PortChipView({
  terminals,
  worktreeId
}: {
  terminals: readonly Terminal[]
  worktreeId: string
}): React.JSX.Element | null {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const chip = portChip(terminals, worktreeId, (id) => worktrees.find((entry) => entry.id === id)?.name ?? id)
  if (chip === null) return null
  return (
    // Inside the row's button, so a span: a nested link would open the row as well.
    <span
      className={`chip worktree__port${chip.clash ? ' worktree__port--clash' : ''}`}
      role="link"
      data-tip={chip.title}
      onClick={(event) => {
        event.stopPropagation()
        openInBrowser(chip.url)
      }}
    >
      {chip.label}
    </span>
  )
}
