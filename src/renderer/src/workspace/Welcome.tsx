// The front door: what the main column shows when there is nothing in it.
//
// It used to be a different card for each of three situations — no project, no
// worktree picked, a worktree with no panes — and the last of those was a row
// of buttons, one per agent this machine has installed. The owner's note on
// that: "it should be like create project or open project, no need to have
// buttons for claude, codex". An agent is chosen in the task composer and in
// the panes tab's picker; the front door is not a third place to choose one.
//
// So one card for all three: the mark, the name, the two things a person opens
// this app to do — and a terminal, when there is a worktree under it to open
// one in, because a shell is a different thing from an agent — then the three
// chords worth knowing in the first hour, named the way the menu bar names
// them. No headline sentence: the buttons carry the meaning. And no more
// chords than three: this is the one surface in the window that teaches any,
// besides the menu bar, the palette and the help page, which is the owner's
// rule — "too many places explaining shortcuts".

import { hasCheckout, type Project, type Worktree } from '@shared/entities'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { menuLabel } from '../menu/menuBar'
import { BrandMark } from '../shell/Brand'
import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore } from '../state/workspaceStore'

export const REPOSITORY_URL = 'https://github.com/zero-abd/teamree'

/**
 * The shortcut list, in the order somebody would need them: the chord that
 * makes a task, the one that reaches everything else, and the one that gives
 * the panes the whole window. Commands rather than words, so the label and the
 * chord are both read from the table the menu bar is built from and cannot
 * drift from it.
 */
const SHORTCUT_COMMANDS: readonly WorkspaceCommand[] = ['new-worktree', 'open-palette', 'toggle-sidebar']

export function Welcome({
  modifier,
  project,
  worktree
}: {
  modifier: PlatformModifier
  /** Where a new task would go; undefined until a project has been added. */
  project: Project | undefined
  /** The worktree on screen, when one is. A terminal is offered only in one with a checkout. */
  worktree: Worktree | undefined
}): React.JSX.Element {
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const createTerminal = useWorkspaceStore((state) => state.createTerminal)
  const terminalHere = worktree !== undefined && hasCheckout(worktree)

  return (
    <div className="welcome">
      <span className="brand__tile brand__tile--welcome" aria-hidden="true">
        <BrandMark />
      </span>
      <span className="wordmark wordmark--welcome">
        teamree
        <span className="wordmark__dot" aria-hidden="true" />
      </span>

      <div className="welcome__actions">
        <button
          type="button"
          className={project === undefined ? 'button button--primary button--lead' : 'button button--lead'}
          onClick={() => openDialog({ kind: 'add-project' })}
        >
          Add project
        </button>
        {/* Live from the first project on: the composer needs somewhere to
            make the worktree, and a button that opened nothing would be a
            promise about a key that does not answer either. */}
        <button
          type="button"
          className={project === undefined ? 'button button--lead' : 'button button--primary button--lead'}
          disabled={project === undefined}
          onClick={() => {
            if (project) openDialog({ kind: 'new-task', projectId: project.id })
          }}
        >
          New task
        </button>
        {terminalHere ? (
          <button type="button" className="button button--lead" onClick={() => void createTerminal(worktree.id)}>
            New terminal
          </button>
        ) : null}
      </div>

      <dl className="welcome__shortcuts">
        {SHORTCUT_COMMANDS.map((command) => (
          <div key={command} data-command={command}>
            <dt>{menuLabel(command)}</dt>
            <dd>
              <kbd>{shortcutHint(command, modifier)}</kbd>
            </dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        className="button button--small welcome__star"
        onClick={() => openInBrowser(REPOSITORY_URL)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1.2 7.45 4.2 10.7 4.65 8.35 6.95 8.9 10.2 6 8.65 3.1 10.2 3.65 6.95 1.3 4.65 4.55 4.2Z" />
        </svg>
        Star on GitHub
      </button>
    </div>
  )
}
