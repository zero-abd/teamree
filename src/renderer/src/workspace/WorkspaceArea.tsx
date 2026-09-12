// The right-hand side: which worktree is open, what it is doing, and its panes.

import { useCallback } from 'react'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { PaneTree } from '../panes/PaneTree'
import { useWorkspaceStore } from '../state/workspaceStore'
import { WorktreeTabs } from './WorktreeTabs'

export function WorkspaceArea({
  modifier,
  isAppChord
}: {
  modifier: PlatformModifier
  isAppChord: (event: KeyboardEvent) => boolean
}): React.JSX.Element {
  const activeWorktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeTerminal = useWorkspaceStore((state) => state.closeTerminal)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const splitFocusedPane = useWorkspaceStore((state) => state.splitFocusedPane)
  const applySplitSizes = useWorkspaceStore((state) => state.applySplitSizes)

  const onResize = useCallback(
    (path: number[], sizes: number[]) => {
      if (activeWorktreeId) applySplitSizes(activeWorktreeId, path, sizes)
    },
    [activeWorktreeId, applySplitSizes]
  )
  const onClose = useCallback((terminalId: string) => void closeTerminal(terminalId), [closeTerminal])

  if (!worktree || !activeWorktreeId) {
    return (
      <main className="workspace workspace--empty">
        <div className="placeholder">
          <h1 className="placeholder__title">Nothing open</h1>
          <p className="placeholder__body">
            Pick a worktree on the left, or start a new one with <kbd>{shortcutHint('new-worktree', modifier)}</kbd>.
          </p>
          <dl className="legend">
            <div>
              <dt>{shortcutHint('split-right', modifier)}</dt>
              <dd>split right</dd>
            </div>
            <div>
              <dt>{shortcutHint('split-down', modifier)}</dt>
              <dd>split down</dd>
            </div>
            <div>
              <dt>{shortcutHint('close-pane', modifier)}</dt>
              <dd>close pane</dd>
            </div>
            <div>
              <dt>{shortcutHint('focus-next-pane', modifier)}</dt>
              <dd>next pane</dd>
            </div>
          </dl>
        </div>
      </main>
    )
  }

  return (
    <main className="workspace">
      <WorktreeTabs />

      <header className="workspace__head">
        <div className="workspace__identity">
          <h1 className="workspace__title">{worktree.name}</h1>
          <p className="workspace__path">{worktree.path}</p>
        </div>
        <div className="workspace__tools">
          <button
            type="button"
            className="button button--ghost button--small"
            title={`Split right · ${shortcutHint('split-right', modifier)}`}
            onClick={() => void splitFocusedPane('row')}
          >
            Split right
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            title={`Split down · ${shortcutHint('split-down', modifier)}`}
            onClick={() => void splitFocusedPane('column')}
          >
            Split down
          </button>
          <button
            type="button"
            className="button button--small"
            title={`New terminal · ${shortcutHint('new-terminal', modifier)}`}
            onClick={() => void createTerminal(activeWorktreeId)}
          >
            New terminal
          </button>
        </div>
      </header>

      <div className="workspace__panes">
        {layout?.root ? (
          <PaneTree
            node={layout.root}
            path={[]}
            terminals={terminals}
            focusedTerminalId={layout.focusedTerminalId}
            onFocus={focusPane}
            onClose={onClose}
            onResize={onResize}
            isAppChord={isAppChord}
            closeHint={shortcutHint('close-pane', modifier)}
          />
        ) : (
          <div className="placeholder placeholder--inset">
            <h2 className="placeholder__title">
              {worktree.state === 'creating' ? 'Preparing the worktree' : 'No terminals here yet'}
            </h2>
            <p className="placeholder__body">
              {worktree.state === 'creating'
                ? 'Panes appear as soon as the checkout is ready.'
                : `Start one with ${shortcutHint('new-terminal', modifier)}.`}
            </p>
            {worktree.state === 'ready' ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => void createTerminal(activeWorktreeId)}
              >
                New terminal
              </button>
            ) : null}
          </div>
        )}
      </div>
    </main>
  )
}
