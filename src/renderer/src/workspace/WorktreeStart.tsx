// An open worktree with no panes: its name and branch, and the `+` menu's pane rows as buttons.

import { hasCheckout, type Worktree } from '@shared/entities'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { useStartMenuItems } from './startMenu'

export function WorktreeStart({
  worktree,
  modifier
}: {
  worktree: Worktree
  modifier: PlatformModifier
}): React.JSX.Element {
  // Nothing can start in a checkout that is not on disk yet, or any more.
  const items = useStartMenuItems(hasCheckout(worktree) ? worktree.id : null, modifier, true)
  const display = worktreeDisplay(worktree)
  return (
    <div className="worktree-start">
      <h1 className="worktree-start__name">{worktreeLabel(display)}</h1>
      {display.branch === undefined ? null : <span className="worktree-start__branch">{display.branch}</span>}
      {items.length === 0 ? null : (
        <div className="worktree-start__actions">
          {items.map((item) => (
            <button key={item.label} type="button" className="button button--lead" onClick={item.onChoose}>
              {item.icon === undefined ? null : (
                <span className="worktree-start__icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
