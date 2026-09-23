// The panes of the worktree on screen, one row each, as the sidebar draws them
// under the worktree — and a way to add one.
//
// The same rows and the same reading, by construction: `agentRows` over the
// same terminals, `PaneRows` for the drawing. What this tab adds is that they
// are beside the panes they describe, which is where somebody looking at four
// agents wants the list of which one is waiting.

import { useMemo } from 'react'
import type { Worktree } from '@shared/entities'
import { agentRows } from '../../sidebar/agentRows'
import { PaneRows } from '../../sidebar/PaneRows'
import { usePaneEvidence } from '../../sidebar/usePaneEvidence'
import { attentionByPane } from '../../state/paneAttention'
import { useNow } from '../../state/useNow'
import { useUnreadPanes } from '../../state/usePaneSeen'
import { useWorkspaceStore } from '../../state/workspaceStore'

export function PanesTab({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const terminals = useWorkspaceStore((state) => state.terminals)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const watching = useWorkspaceStore((state) => state.watchers[worktree.projectId])
  const now = useNow()
  const unread = useUnreadPanes()

  const mine = useMemo(
    () => Object.values(terminals).filter((terminal) => terminal.worktreeId === worktree.id),
    [terminals, worktree.id]
  )
  // A second reader of the same panes the sidebar reads, while this tab is up.
  // Cheap — one tail read per pane on the sidebar's own schedule — and only for
  // the worktree on screen.
  const evidence = usePaneEvidence(mine, terminals)
  const rows = agentRows(mine, worktree.id, now, evidence)
  const reading = useMemo(() => attentionByPane(watching), [watching])

  return (
    <section className="panel__panes" aria-label="Panes in this worktree">
      <div className="panel__toolbar">
        <span className="panel__toolbarText">
          {rows.length} pane{rows.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          className="panel__tool"
          aria-label="New terminal"
          title="New terminal"
          onClick={() => void createTerminal(worktree.id)}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 2 V10 M2 6 H10" />
          </svg>
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="panel__empty">No panes</p>
      ) : (
        <PaneRows
          className="panes--panel"
          rows={rows}
          worktreeName={worktree.name}
          watchers={reading}
          unread={unread}
          now={now}
          onFocusTerminal={focusPane}
        />
      )}
    </section>
  )
}
