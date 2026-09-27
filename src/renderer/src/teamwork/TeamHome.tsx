// The team's home on the Teamwork page: invite and join, what waits on you, who is here and what
// their agents are doing, shared notes, and recent activity. Every row leads to the thing it names.

import { useEffect, useMemo, useState } from 'react'
import { watchedPaneId } from '../panes/watchedPanes'
import { AnswerButtons } from '../sidebar/AnswerButtons'
import { agentRows, agoLabel, dotClass, worktreeTone } from '../sidebar/agentRows'
import type { TeammatePaneRow } from '../sidebar/teammateRows'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Avatar, type Presence } from './Avatar'
import { takeHandoff } from './HandoffPopups'
import { useHandoffs } from './handoffsStore'
import { SharedNotesList } from './SharedNotesList'
import { listedNotes, useSharedNotes } from './sharedNotesStore'
import {
  activityWhen,
  presenceLabel,
  teamActivity,
  teamLine,
  teamMembers,
  waitingOnYou,
  type MemberWorktree,
  type OwnWorktree,
  type TeamMember,
  type WaitingItem
} from './homeRows'
import { rememberTeammates, teamMemory } from './teamMemory'
import { CopyInviteButton, PasteInvitation } from './TeamworkSteps'

rememberTeammates(useWorkspaceStore)

/** Relative times move on this tick; nothing is read on it. */
const CLOCK_TICK_MS = 15_000

/** Worktrees shown per member before the rest fold into a count. */
const WORKTREES_SHOWN = 4

export function TeamHome({
  projectId,
  invite,
  onCopy,
  onPasteInvitation
}: {
  projectId: string
  /** The message to send a teammate, or null with no origin to name. */
  invite: string | null
  onCopy: (text: string) => void
  onPasteInvitation?: (raw: string) => string | null
}): React.JSX.Element {
  const list = useWorkspaceStore((state) => state.members[projectId])
  const status = useWorkspaceStore((state) => state.teamwork[projectId])
  const presence = useWorkspaceStore((state) => state.teammates[projectId])
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const handoffs = useHandoffs((state) => state.byProject[projectId])
  const inbox = useSharedNotes((state) => state.inbox)
  const deleting = useSharedNotes((state) => state.deleting)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const own = useMemo((): OwnWorktree[] => {
    const panes = Object.values(terminals)
    return worktrees
      .filter((worktree) => worktree.projectId === projectId)
      .map((worktree) => ({
        id: worktree.id,
        name: worktree.task ?? worktreeDisplay(worktree).title,
        tone: worktreeTone(agentRows(panes, worktree.id, now).filter((row) => row.agent !== undefined))
      }))
      .filter((worktree) => worktree.tone !== null)
  }, [now, projectId, terminals, worktrees])

  const members = teamMembers({ list, presence, status, own, memory: teamMemory, now })
  const waiting = waitingOnYou({ handoffs, presence, now })
  const notes = listedNotes({ inbox, deleting }, projectId)
  const activity = teamActivity({ list, handoffs, notes, presence, memory: teamMemory, projectId })
  const line = teamLine(status)

  return (
    <div className="team-home">
      <div className="team-home__bar">
        <CopyInviteButton invite={invite} onCopy={onCopy} className="button button--primary button--small" />
        {onPasteInvitation === undefined ? null : <PasteInvitation onPaste={onPasteInvitation} />}
      </div>
      {line === null ? null : <p className="team-home__line">{line}</p>}

      <section className="team-home__section" aria-label="Waiting on You">
        <h2 className="team-home__head">Waiting on You</h2>
        {waiting.length === 0 ? (
          <p className="team-home__empty">Nothing waiting</p>
        ) : (
          <ul className="team-waiting">
            {waiting.map((item) => (
              <WaitingRow
                key={item.kind === 'handoff' ? item.handoff.id : item.pane.terminalId}
                item={item}
                projectId={projectId}
                now={now}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="team-home__section" aria-label="Members">
        <h2 className="team-home__head">Members</h2>
        <ul className="team-members">
          {members.map((member) => (
            <MemberRow key={member.publicKey} member={member} projectId={projectId} now={now} />
          ))}
        </ul>
        {members.some((member) => !member.isSelf) ? null : <p className="team-home__empty">No teammates yet</p>}
      </section>

      <SharedNotesList projectId={projectId} empty="No shared notes" />

      <section className="team-home__section" aria-label="Activity">
        <h2 className="team-home__head">Activity</h2>
        {activity.length === 0 ? (
          <p className="team-home__empty">No activity yet</p>
        ) : (
          <ul className="team-activity">
            {activity.map((item) => (
              <li key={item.key} className="team-activity__row">
                <Avatar handle={item.handle} size="xs" decorative />
                <span className="team-activity__text">{item.text}</span>
                <span className="team-activity__when">{activityWhen(item, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function WaitingRow({
  item,
  projectId,
  now
}: {
  item: WaitingItem
  projectId: string
  now: number
}): React.JSX.Element {
  const dismiss = useHandoffs((state) => state.dismiss)
  const answerTeammatePane = useWorkspaceStore((state) => state.answerTeammatePane)
  if (item.kind === 'handoff') {
    const { handoff } = item
    const from = handoff.from ?? 'a teammate'
    return (
      <li className="team-waiting__row" title={handoff.note}>
        <Avatar handle={from} size="xs" decorative />
        <span className="team-waiting__text">
          {from} handed you <strong>{handoff.worktreeName}</strong>
        </span>
        <span className="team-waiting__when">{agoLabel(Math.max(0, now - handoff.at))}</span>
        <button
          type="button"
          className="button button--primary button--small"
          onClick={() => void takeHandoff(projectId, handoff.id)}
        >
          Take
        </button>
        <button type="button" className="button button--small" onClick={() => void dismiss(projectId, handoff.id)}>
          Dismiss
        </button>
      </li>
    )
  }
  return (
    <li className="team-waiting__row">
      <Avatar handle={item.handle} size="xs" decorative />
      <span className="team-waiting__text">
        {item.handle} · <strong>{item.worktree}</strong> asking
      </span>
      <AnswerButtons
        terminalId={item.pane.terminalId}
        choices={item.pane.choices ?? []}
        className="team-waiting__answers"
        onChoose={(choice) => void answerTeammatePane(projectId, item.pane, choice)}
      />
      <OpenPane projectId={projectId} pane={item.pane} />
    </li>
  )
}

function MemberRow({
  member,
  projectId,
  now
}: {
  member: TeamMember
  projectId: string
  now: number
}): React.JSX.Element {
  const shown = member.worktrees.slice(0, WORKTREES_SHOWN)
  const folded = member.worktrees.length - shown.length
  return (
    <li className={`team-member team-member--${member.presence}`}>
      <Avatar handle={member.handle} size="md" presence={avatarPresence(member.presence)} decorative />
      <div className="team-member__body">
        <p className="team-member__line">
          <span className="team-member__handle">{member.handle}</span>
          <span className={`team-member__presence team-member__presence--${member.presence}`}>
            {presenceLabel(member, now)}
          </span>
        </p>
        {shown.length === 0 ? null : (
          <ul className="team-member__worktrees">
            {shown.map((worktree) => (
              <li key={worktree.id}>
                <WorktreeButton worktree={worktree} projectId={projectId} handle={member.handle} />
              </li>
            ))}
            {folded > 0 ? <li className="team-member__more">+{folded} more</li> : null}
          </ul>
        )}
      </div>
    </li>
  )
}

/** You and a teammate never seen draw no presence mark; the word beside says which. */
function avatarPresence(presence: TeamMember['presence']): Presence {
  return presence === 'online' || presence === 'away' ? presence : 'unknown'
}

/** Your own opens where its agents run; a teammate's opens its first pane, watched. */
function WorktreeButton({
  worktree,
  projectId,
  handle
}: {
  worktree: MemberWorktree
  projectId: string
  handle: string
}): React.JSX.Element {
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const watch = useWatch(projectId)
  const { pane } = worktree
  return (
    <button
      type="button"
      className="team-worktree"
      disabled={!worktree.own && pane === undefined}
      title={worktree.own ? undefined : `${handle}’s worktree on their machine`}
      onClick={() => {
        if (worktree.own) void openWorktree(worktree.id)
        else if (pane !== undefined) watch(pane)
      }}
    >
      {/* Hidden rather than absent when nothing runs, so the names line up; the word says it aloud. */}
      <span
        className={worktree.tone === null ? 'activity team-worktree__nodot' : dotClass(worktree.tone)}
        aria-hidden="true"
      />
      <span className="team-worktree__name">{worktree.name}</span>
      {worktree.word === null ? null : <span className="team-worktree__word">{worktree.word}</span>}
    </button>
  )
}

function OpenPane({ projectId, pane }: { projectId: string; pane: TeammatePaneRow }): React.JSX.Element {
  const watch = useWatch(projectId)
  return (
    <button type="button" className="button button--small" onClick={() => watch(pane)}>
      Open
    </button>
  )
}

/** Opens a teammate's pane in the workspace, which this page would cover, or focuses it when already open. */
function useWatch(projectId: string): (pane: TeammatePaneRow) => void {
  const closeTeamwork = useWorkspaceStore((state) => state.closeTeamwork)
  const toggleWatchedPane = useWorkspaceStore((state) => state.toggleWatchedPane)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  return (pane) => {
    closeTeamwork()
    const id = watchedPaneId(projectId, pane.terminalId)
    if (useWorkspaceStore.getState().watches.some((open) => open.id === id)) focusPane(id)
    else toggleWatchedPane(projectId, { terminalId: pane.terminalId, label: pane.label, handle: pane.handle })
  }
}
