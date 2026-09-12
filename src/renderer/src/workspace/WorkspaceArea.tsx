// The right-hand side: which worktree is open, what it is doing, and its panes.

import { useCallback } from 'react'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { PaneTree } from '../panes/PaneTree'
import { ChangesPanel } from './ChangesPanel'
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
  const changesOpen = useWorkspaceStore((state) => state.changesOpen)
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const pushing = useWorkspaceStore((state) => state.pushing)
  const pushActiveWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)

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
            <div>
              <dt>{shortcutHint('open-palette', modifier)}</dt>
              <dd>go to anything</dd>
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
            className={`button button--ghost button--small${changesOpen ? ' button--on' : ''}`}
            aria-pressed={changesOpen}
            title={`Show what changed in this worktree · ${shortcutHint('open-palette', modifier)} to jump anywhere`}
            onClick={toggleChanges}
          >
            Changes
            {changedCount(status) > 0 ? <span className="button__count">{changedCount(status)}</span> : null}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={pushing}
            title={
              status === undefined
                ? 'Send this branch to its remote'
                : status.ahead > 0
                  ? `Send ${status.ahead} commit${status.ahead === 1 ? '' : 's'} to the remote. Never forces.`
                  : 'Nothing to send; the remote already has this branch.'
            }
            onClick={() => void pushActiveWorktree()}
          >
            {pushing ? 'Pushing…' : 'Push'}
            {status !== undefined && status.ahead > 0 ? <span className="button__count">{status.ahead}</span> : null}
          </button>
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

      <div className="workspace__body">
        <div className="workspace__panes">
          {layout?.root ? (
            <PaneTree
              key={activeWorktreeId}
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

        <ChangesPanel />
      </div>
    </main>
  )
}

/**
 * What the button's badge counts: everything a commit would have to deal with.
 * Ahead and behind are about the branch rather than the tree, so they are the
 * status bar's business, not this button's.
 */
export function changedCount(
  status: { staged: number; unstaged: number; untracked: number; conflicted: number } | undefined
): number {
  if (!status) return 0
  return status.staged + status.unstaged + status.untracked + status.conflicted
}
