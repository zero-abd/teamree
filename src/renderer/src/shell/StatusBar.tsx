// The bottom rail: is the runtime there, what am I looking at, how much of it
// is running. Everything here is a fact. One of them — the git line — is also
// the way into the changes panel, because it is the line that already says what
// the panel is about; the row above the panes that used to carry a button for
// the same fact is gone.

import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { collectTerminalIds } from '../panes/paneLayout'
import { formatReadAge, summarizeWorktreeStatus } from '../sidebar/worktreeStatusSummary'
import { RUNTIME_IS_SEEDED } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  ready: 'Runtime ready',
  retrying: 'Reconnecting',
  offline: 'Runtime offline'
}

export function StatusBar({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const connection = useWorkspaceStore((state) => state.connection)
  const runtimeVersion = useWorkspaceStore((state) => state.runtimeVersion)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const totalTerminals = useWorkspaceStore((state) => Object.keys(state.terminals).length)
  // Pressed while the changes tab is what the right panel shows: that is the
  // one state the click below closes rather than opens.
  const changesOpen = useWorkspaceStore((state) => state.rightPanelOpen && state.rightPanelTab === 'changes')
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)

  const paneCount = collectTerminalIds(layout?.root ?? null).length
  const summary = summarizeWorktreeStatus(status)

  return (
    <footer className="statusbar">
      <span
        className={`statusbar__item statusbar__connection statusbar__connection--${connection.phase}`}
        title={connection.detail ?? CONNECTION_LABEL[connection.phase]}
      >
        <span className="statusbar__dot" aria-hidden="true" />
        {CONNECTION_LABEL[connection.phase] ?? connection.phase}
        {runtimeVersion ? <span className="statusbar__muted">{runtimeVersion}</span> : null}
      </span>

      <span className="statusbar__item">
        {worktree ? (
          <>
            <span className="statusbar__muted">worktree</span>
            {worktree.name}
            <span className="statusbar__branch">{worktree.branch}</span>
          </>
        ) : (
          <span className="statusbar__muted">no worktree open</span>
        )}
      </span>

      {summary && status ? (
        // The count is in the name as well as on the button, so somebody
        // driving this by voice can say what they see. Offered for a clean tree
        // too: the panel is where the last commits are read, not only where
        // dirty files are staged.
        <button
          type="button"
          className={`statusbar__item statusbar__button${changesOpen ? ' statusbar__button--on' : ''}`}
          aria-pressed={changesOpen}
          aria-label={`Changes, ${summary.description}`}
          title={`Changes · read ${formatReadAge(status.readAt, Date.now())}`}
          onClick={toggleChanges}
        >
          <span className="statusbar__muted">git</span>
          {summary.description}
        </button>
      ) : null}

      <span className="statusbar__spacer" />

      {RUNTIME_IS_SEEDED ? <span className="statusbar__badge">seeded data</span> : null}

      <span className="statusbar__item">
        <span className="statusbar__muted">split</span>
        <kbd>{shortcutHint('split-right', modifier)}</kbd>
        <kbd>{shortcutHint('split-down', modifier)}</kbd>
      </span>

      <span className="statusbar__item">
        <span className="statusbar__muted">find</span>
        <kbd>{shortcutHint('find-in-pane', modifier)}</kbd>
      </span>

      {/* The four chords that go somewhere without the mouse, in the order they
          move: down the sidebar, then around the panes of whatever it lands on.
          Here rather than only in the help page because a chord nobody has been
          told is a chord nobody presses, and this rail is where somebody's eye
          already is while they are deciding to reach for the trackpad. */}
      <span className="statusbar__item" title="Previous and next worktree, previous and next pane">
        <span className="statusbar__muted">move</span>
        <kbd>{shortcutHint('previous-worktree', modifier)}</kbd>
        <kbd>{shortcutHint('next-worktree', modifier)}</kbd>
        <kbd>{shortcutHint('focus-previous-pane', modifier)}</kbd>
        <kbd>{shortcutHint('focus-next-pane', modifier)}</kbd>
      </span>

      <span className="statusbar__item" title={`${totalTerminals} terminals across all worktrees`}>
        <span className="statusbar__muted">terminals</span>
        {paneCount}
        <span className="statusbar__muted">/ {totalTerminals}</span>
      </span>
    </footer>
  )
}
