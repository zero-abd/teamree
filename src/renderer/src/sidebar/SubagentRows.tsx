// The subagents of one pane's session, under its row; a click opens the transcript.

import type { Subagent } from '@shared/entities'
import { dotClass, truncateName } from './agentRows'
import { elapsedLabel, SUBAGENT_TONE, subagentElapsed, subagentTitle, subagentTree } from './subagentTree'

type SubagentRowsProps = {
  subagents: readonly Subagent[]
  now: number
  onOpen: (subagent: Subagent) => void
  /** The pane row's tree level; these sit one below it and deeper. */
  level?: number
}

export function SubagentRows({ subagents, now, onOpen, level }: SubagentRowsProps): React.JSX.Element {
  return (
    <ul className="subagents" role={level === undefined ? undefined : 'group'} aria-label="Subagents">
      {subagentTree(subagents).map(({ subagent, depth }) => (
        <li key={subagent.id} role={level === undefined ? undefined : 'none'}>
          <button
            type="button"
            className={`subagent-row subagent-row--${subagent.status}`}
            {...(level === undefined ? {} : { role: 'treeitem', 'aria-level': level + 1 + depth, tabIndex: -1 })}
            style={{ '--subagent-depth': depth } as React.CSSProperties}
            title={subagentTitle(subagent, now)}
            onClick={() => onOpen(subagent)}
          >
            <span className={dotClass(SUBAGENT_TONE[subagent.status])} aria-label={subagent.status} />
            <span className="subagent-row__label">{truncateName(subagent.description)}</span>
            <span className="subagent-row__since">{elapsedLabel(subagentElapsed(subagent, now))}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
