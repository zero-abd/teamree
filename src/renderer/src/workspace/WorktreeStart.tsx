// An open worktree with no panes: its name and branch, and the `+` menu's pane rows as buttons.
// When an agent closed here can resume its conversation, that is the one primary button.

import { useEffect } from 'react'
import { hasCheckout, type Worktree } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { resumableAgent } from '../state/closedPanes'
import { useWorkspaceStore } from '../state/workspaceStore'
import { useStartMenuItems } from './startMenu'

export function WorktreeStart({
  worktree,
  modifier
}: {
  worktree: Worktree
  modifier: PlatformModifier
}): React.JSX.Element {
  // Nothing can start in a checkout that is not on disk yet, or any more.
  const ready = hasCheckout(worktree)
  const items = useStartMenuItems(ready ? worktree.id : null, modifier, true)
  const closed = useWorkspaceStore((state) => state.closedPanes[worktree.id])
  const loadClosedPanes = useWorkspaceStore((state) => state.loadClosedPanes)
  const reopenTerminal = useWorkspaceStore((state) => state.reopenTerminal)
  useEffect(() => {
    if (ready) void loadClosedPanes(worktree.id)
  }, [ready, worktree.id, loadClosedPanes])
  const resume = ready ? resumableAgent(closed ?? []) : null
  const display = worktreeDisplay(worktree)
  return (
    <div className="worktree-start">
      <h1 className="worktree-start__name" aria-label={worktreeLabel(display)}>
        {display.agent?.kind === undefined ? null : <AgentGlyph kind={display.agent.kind} decorative />}
        {display.title}
      </h1>
      {display.branch === undefined ? null : <span className="worktree-start__branch">{display.branch}</span>}
      {items.length === 0 ? null : (
        <div className="worktree-start__actions">
          {resume === null || resume.agent === undefined ? null : (
            <button
              type="button"
              className="button button--lead button--primary"
              onClick={() => void reopenTerminal(worktree.id, resume.terminalId)}
            >
              <span className="worktree-start__icon" aria-hidden="true">
                <AgentGlyph kind={resume.agent} />
              </span>
              {`Resume ${harnessName(resume.agent)}`}
            </button>
          )}
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
