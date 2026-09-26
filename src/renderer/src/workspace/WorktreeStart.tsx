// An open worktree with no panes: its name and branch, and the `+` menu's pane rows as buttons.
// Resuming goes on a row of its own; an agent closed here that can pick its conversation up is the one primary button.

import { useEffect } from 'react'
import { hasCheckout, type Worktree } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { resumableAgent } from '../state/closedPanes'
import { useWorkspaceStore } from '../state/workspaceStore'
import { RESUME_CONVERSATION, useStartMenuItems } from './startMenu'

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
  const loadConversations = useWorkspaceStore((state) => state.loadConversations)
  useEffect(() => {
    if (!ready) return
    void loadClosedPanes(worktree.id)
    void loadConversations(worktree.id)
  }, [ready, worktree.id, loadClosedPanes, loadConversations])
  const resume = ready ? resumableAgent(closed ?? []) : null
  const panes = items.filter((item) => item.label !== RESUME_CONVERSATION)
  const history = items.filter((item) => item.label === RESUME_CONVERSATION)
  const button = (item: (typeof items)[number], quiet = false): React.JSX.Element => (
    <button
      key={item.label}
      type="button"
      className={`button button--lead${quiet ? ' button--ghost' : ''}`}
      onClick={item.onChoose}
    >
      {item.icon === undefined ? null : (
        <span className="worktree-start__icon" aria-hidden="true">
          {item.icon}
        </span>
      )}
      {item.label}
    </button>
  )
  const display = worktreeDisplay(worktree)
  return (
    <div className="worktree-start">
      <h1 className="worktree-start__name" aria-label={worktreeLabel(display)}>
        {display.agent?.kind === undefined ? null : <AgentGlyph kind={display.agent.kind} decorative />}
        {display.title}
      </h1>
      {display.branch === undefined ? null : <span className="worktree-start__branch">{display.branch}</span>}
      {worktree.issue === undefined ? null : (
        <a className="worktree-start__issue" href={worktree.issue.url} target="_blank" rel="noreferrer">
          {`#${worktree.issue.number}`}
        </a>
      )}
      {panes.length === 0 ? null : <div className="worktree-start__actions">{panes.map((item) => button(item))}</div>}
      {resume?.agent === undefined && history.length === 0 ? null : (
        <div className="worktree-start__actions worktree-start__actions--resume">
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
          {history.map((item) => button(item, true))}
        </div>
      )}
    </div>
  )
}
