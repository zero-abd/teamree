// Teammates' worktrees under the project, one foldable group per person: their face, whether they
// are here, and what their agents are doing on the group's own row. Offers waiting for you come first.

import type { ScreenChoice } from '@shared/screenOpinion'
import type { PeerHandoff } from '@shared/tasks'
import { Avatar } from '../teamwork/Avatar'
import { takeHandoff } from '../teamwork/HandoffPopups'
import { useHandoffs } from '../teamwork/handoffsStore'
import { activityWords, presenceWords, type TeammateGlance, type TheirOverlap } from './teamGlance'
import { isFolded, useTeamFold } from './teamFold'
import type { TeammatePaneRow, TeammateWorktreeRowModel } from './teammateRows'
import { TeammateWorktreeRow } from './TeammateWorktreeRow'

type TeammateGroupsProps = {
  projectId: string
  glance: readonly TeammateGlance[]
  /** The rows the filter left. */
  rows: readonly TeammateWorktreeRowModel[]
  /** A filter shows its matches, so it opens every group. */
  narrowing: boolean
  watchingPaneIds: readonly string[]
  onWatch: (pane: TeammatePaneRow) => void
  onAnswer: (pane: TeammatePaneRow, choice: ScreenChoice) => void
  overlapOf: (rowId: string) => (TheirOverlap & { onOpen: () => void }) | null
}

export function TeammateGroups({
  projectId,
  glance,
  rows,
  narrowing,
  watchingPaneIds,
  onWatch,
  onAnswer,
  overlapOf
}: TeammateGroupsProps): React.JSX.Element {
  const folded = useTeamFold((state) => state.folded)
  const setFolded = useTeamFold((state) => state.setFolded)
  return (
    <>
      {glance.map((teammate) => {
        const theirs = rows.filter((row) => row.handle === teammate.handle)
        if (theirs.length === 0) return null
        const closed = !narrowing && isFolded(folded, projectId, teammate.handle)
        const toggle = (): void => setFolded(projectId, teammate.handle, !closed)
        const stale = theirs.find((row) => row.staleness !== null)?.staleness
        return (
          <li
            key={teammate.handle}
            className={`teammate teammate--${teammate.presence}`}
            role="none"
            data-teammate={teammate.handle}
          >
            <div
              className="teammate__head"
              role="treeitem"
              aria-level={2}
              aria-expanded={!closed}
              aria-label={`${teammate.handle}, ${presenceWords(teammate, true)} · ${activityWords(teammate)}`}
              tabIndex={-1}
              title={stale?.detail}
              data-teammate-head={teammate.handle}
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
                if (event.key === (closed ? 'ArrowRight' : 'ArrowLeft') || event.key === 'Enter') {
                  event.preventDefault()
                  toggle()
                }
              }}
            >
              <svg className={`chevron${closed ? '' : ' chevron--open'}`} viewBox="0 0 12 12" aria-hidden="true">
                <path d="M4.5 2.5 L8.5 6 L4.5 9.5" />
              </svg>
              <Avatar handle={teammate.handle} presence={teammate.presence} decorative />
              <span className="teammate__name">{teammate.handle}</span>
              {teammate.presence === 'online' ? null : (
                <span className="teammate__presence">{presenceWords(teammate)}</span>
              )}
              <span className={`teammate__doing${teammate.asking > 0 ? ' teammate__doing--asking' : ''}`}>
                {activityWords(teammate)}
              </span>
            </div>
            {closed ? null : (
              <ul className="teammate__rows" role="group">
                {theirs.map((row) => {
                  const overlap = overlapOf(row.id)
                  return (
                    <TeammateWorktreeRow
                      key={row.id}
                      row={row}
                      {...(overlap === null ? {} : { overlap })}
                      watchingPaneIds={watchingPaneIds}
                      onWatch={onWatch}
                      onAnswer={onAnswer}
                    />
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}

/** Worktrees a teammate handed you, waiting to be taken: the row reads like a worktree with its two answers. */
export function HandoffRows({ projectId }: { projectId: string }): React.JSX.Element | null {
  const incoming = useHandoffs((state) => state.byProject[projectId]?.incoming ?? NONE)
  const dismiss = useHandoffs((state) => state.dismiss)
  if (incoming.length === 0) return null
  return (
    <>
      {incoming.map((handoff) => (
        <li key={handoff.id} className="handoff-row" role="none">
          <div
            className="handoff-row__row"
            role="treeitem"
            aria-level={2}
            tabIndex={-1}
            title={handoff.note}
            data-handoff={handoff.id}
          >
            <span className="handoff-row__title">
              <Avatar handle={handoff.from ?? '?'} size="xs" decorative />
              <span className="handoff-row__name">{handoff.worktreeName}</span>
            </span>
            <span className="handoff-row__meta">
              <span className="handoff-row__from">{`from ${handoff.from ?? 'a teammate'}`}</span>
              <button
                type="button"
                className="handoff-row__take"
                tabIndex={-1}
                onClick={() => void takeHandoff(projectId, handoff.id)}
              >
                Take
              </button>
              <button
                type="button"
                className="handoff-row__dismiss"
                tabIndex={-1}
                onClick={() => void dismiss(projectId, handoff.id)}
              >
                Dismiss
              </button>
            </span>
          </div>
        </li>
      ))}
    </>
  )
}

const NONE: PeerHandoff[] = []
