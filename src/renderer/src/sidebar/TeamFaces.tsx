// The team in a project's head: a face per teammate with presence, a card on hover, and the cues
// (who is asking, a handoff waiting) that stay visible while the project is folded.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Avatar } from '../teamwork/Avatar'
import { dotClass } from './agentRows'
import { activityWords, presenceWords, type TeamCues, type TeammateGlance } from './teamGlance'
import { Icon } from '../icons/Icon'

/** Faces drawn before the rest fold into `+N`. */
export const MAX_FACES = 4

export function TeamFaces({
  glance,
  onReveal,
  onMore
}: {
  glance: readonly TeammateGlance[]
  /** Goes to that teammate's rows. */
  onReveal: (handle: string) => void
  /** The `+N`: opens the team. */
  onMore: () => void
}): React.JSX.Element | null {
  // The handle, not the glance: the card follows what they are doing while it is open.
  const [card, setCard] = useState<{ handle: string; rect: DOMRect } | null>(null)
  if (glance.length === 0) return null
  const shown = glance.slice(0, glance.length > MAX_FACES ? MAX_FACES - 1 : MAX_FACES)
  const hidden = glance.length - shown.length
  const carded = glance.find((teammate) => teammate.handle === card?.handle)
  const show = (teammate: TeammateGlance) => (event: { currentTarget: HTMLElement }) =>
    setCard({ handle: teammate.handle, rect: event.currentTarget.getBoundingClientRect() })
  return (
    <span className="project__faces" role="group" aria-label="Team">
      {shown.map((teammate) => (
        <button
          key={teammate.handle}
          type="button"
          className="project__face"
          tabIndex={-1}
          aria-label={`${teammate.handle}, ${presenceWords(teammate, true)} · ${activityWords(teammate)}`}
          onMouseEnter={show(teammate)}
          onFocus={show(teammate)}
          onMouseLeave={() => setCard(null)}
          onBlur={() => setCard(null)}
          onClick={() => onReveal(teammate.handle)}
        >
          <Avatar handle={teammate.handle} presence={teammate.presence} decorative />
        </button>
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="project__face project__face--more"
          tabIndex={-1}
          title={glance
            .slice(shown.length)
            .map((teammate) => teammate.handle)
            .join(', ')}
          onClick={onMore}
        >
          {`+${hidden}`}
        </button>
      ) : null}
      {carded === undefined || card === null
        ? null
        : createPortal(<TeammateCard teammate={carded} rect={card.rect} />, document.body)}
    </span>
  )
}

const CARD_WIDTH = 240

function TeammateCard({ teammate, rect }: { teammate: TeammateGlance; rect: DOMRect }): React.JSX.Element {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8))
  return (
    <div className="team-card" role="tooltip" style={{ left, top: rect.bottom + 6, width: CARD_WIDTH }}>
      <div className="team-card__head">
        <Avatar handle={teammate.handle} presence={teammate.presence} size="md" decorative />
        <span className="team-card__who">
          <span className="team-card__name">{teammate.handle}</span>
          <span className={`team-card__presence team-card__presence--${teammate.presence}`}>
            {presenceWords(teammate, true)}
          </span>
        </span>
      </div>
      <p className="team-card__doing">{activityWords(teammate)}</p>
      {teammate.worktrees.length === 0 ? null : (
        <ul className="team-card__worktrees">
          {teammate.worktrees.map((worktree) => (
            <li key={worktree.id}>
              <span className="team-card__worktree">{worktree.name}</span>
              {worktree.word === null ? null : (
                <span className="team-card__tone">
                  <span className={dotClass(worktree.tone)} />
                  {worktree.word}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Beside the project's name, so a folded project still says someone is asking or a handoff waits. */
export function TeamCueButtons({
  cues,
  onAsking,
  onHandoff
}: {
  cues: TeamCues
  onAsking: () => void
  onHandoff: () => void
}): React.JSX.Element | null {
  if (cues.asking === null && cues.handoffs === null) return null
  return (
    <span className="project__cues">
      {cues.asking === null ? null : (
        <button
          type="button"
          className="project__cue project__cue--asking"
          tabIndex={-1}
          aria-label={cues.asking.label}
          title={cues.asking.label}
          onClick={onAsking}
        >
          {cues.asking.count === 1 ? (
            <Avatar handle={cues.asking.handle} size="xs" decorative />
          ) : (
            <span className={dotClass('waiting')} aria-hidden="true" />
          )}
          <span className="project__cue-text">
            {cues.asking.count === 1 ? 'asking' : `${cues.asking.count} asking`}
          </span>
        </button>
      )}
      {cues.handoffs === null ? null : (
        <button
          type="button"
          className="project__cue project__cue--handoff"
          tabIndex={-1}
          aria-label={cues.handoffs.label}
          title={cues.handoffs.label}
          onClick={onHandoff}
        >
          <Icon name="handoff" size={14} />
          {cues.handoffs.count > 1 ? <span className="project__cue-text">{cues.handoffs.count}</span> : null}
        </button>
      )}
    </span>
  )
}
