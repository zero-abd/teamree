// The team's home on the Teamwork page: what waits on you, who is here and what their agents are doing,
// shared notes, then activity and the project beside them. Every row leads to the thing it names.

import { useEffect, useMemo, useState } from 'react'
import { landedWhereItLands } from '../dashboard/taskRows'
import { Icon } from '../icons/Icon'
import { watchedPaneId } from '../panes/watchedPanes'
import { AnswerButtons } from '../sidebar/AnswerButtons'
import { agentRows, agoLabel, worktreeTone } from '../sidebar/agentRows'
import type { TeammatePaneRow } from '../sidebar/teammateRows'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Avatar, type Presence } from './Avatar'
import { takeHandoff } from './HandoffPopups'
import { useHandoffs } from './handoffsStore'
import { SharedNotesList } from './SharedNotesList'
import { listedNotes, useSharedNotes } from './sharedNotesStore'
import { paneState } from './paneState'
import { Button } from '../ui/Button'
import { StatusPill } from '../ui/StatusPill'
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

/** Copy Invitation and Paste Invitation…, for the page's head. */
export function TeamInviteActions({
  invite,
  onCopy,
  onPasteInvitation
}: {
  /** The message to send a teammate, or null with no origin to name. */
  invite: string | null
  onCopy: (text: string) => void
  onPasteInvitation?: (raw: string) => string | null
}): React.JSX.Element {
  return (
    <div className="team-invite">
      <CopyInviteButton invite={invite} onCopy={onCopy} className="button button--primary team-invite__copy" />
      {onPasteInvitation === undefined ? null : <PasteInvitation onPaste={onPasteInvitation} />}
    </div>
  )
}

export function TeamHome({ projectId }: { projectId: string }): React.JSX.Element {
  const list = useWorkspaceStore((state) => state.members[projectId])
  const status = useWorkspaceStore((state) => state.teamwork[projectId])
  const presence = useWorkspaceStore((state) => state.teammates[projectId])
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const landings = useWorkspaceStore((state) => state.landings)
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
      .map((worktree) => {
        const tone = worktreeTone(agentRows(panes, worktree, now).filter((row) => row.agent !== undefined))
        // As the sidebar's `taskStage`: an agent working or asking outranks a landing, which outranks a report.
        const stage =
          tone === 'working' || tone === 'waiting'
            ? undefined
            : landedWhereItLands(worktree, landings[worktree.id])
              ? ('landed' as const)
              : worktree.report === undefined
                ? undefined
                : worktree.report.outcome === 'failed'
                  ? ('failed' as const)
                  : ('done' as const)
        return {
          id: worktree.id,
          name: worktreeDisplay(worktree).title,
          tone,
          ...(stage === undefined ? {} : { stage })
        }
      })
      .filter((worktree) => worktree.tone !== null)
  }, [landings, now, projectId, terminals, worktrees])

  const members = teamMembers({ list, presence, status, own, memory: teamMemory, now })
  const waiting = waitingOnYou({ handoffs, presence, now })
  const asking = waiting.filter((item) => item.kind === 'asking')
  const handed = waiting.filter((item) => item.kind === 'handoff')
  const notes = listedNotes({ inbox, deleting }, projectId)
  const activity = teamActivity({ list, handoffs, notes, presence, memory: teamMemory, projectId })
  const line = teamLine(status)

  return (
    <div className="team-home">
      {line === null ? null : <p className="team-home__line">{line}</p>}
      <div className="team-home__grid">
        <div className="team-home__main">
          {/* A handoff alone has its own section; with nothing at all, one line says so. */}
          {asking.length === 0 && handed.length > 0 ? null : (
            <section className="team-home__section" aria-label="Waiting on you">
              <h2 className="team-home__head">Waiting on you</h2>
              {asking.length === 0 ? (
                <p className="team-home__empty">Nothing waiting</p>
              ) : (
                <ul className="home-cards">
                  {asking.map((item) => (
                    <WaitingRow key={rowKey(item)} item={item} projectId={projectId} now={now} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {handed.length === 0 ? null : (
            <section className="team-home__section" aria-label="Handed to you">
              <h2 className="team-home__head">Handed to you</h2>
              <ul className="home-cards">
                {handed.map((item) => (
                  <WaitingRow key={rowKey(item)} item={item} projectId={projectId} now={now} />
                ))}
              </ul>
            </section>
          )}

          <section className="team-home__section" aria-label="Members">
            <h2 className="team-home__head">Members</h2>
            <ul className="card team-members">
              {members.map((member) => (
                <MemberRow key={member.publicKey} member={member} projectId={projectId} now={now} />
              ))}
            </ul>
            {members.some((member) => !member.isSelf) ? null : <p className="team-home__empty">No teammates yet</p>}
          </section>

          <SharedNotesList projectId={projectId} empty="No shared notes" />
        </div>

        <aside className="team-home__side">
          <section className="team-home__section" aria-label="Activity">
            <h2 className="team-home__head">Activity</h2>
            {activity.length === 0 ? (
              <p className="team-home__empty">No activity yet</p>
            ) : (
              <ul className="card team-activity">
                {activity.map((item) => (
                  <li key={item.key} className="team-activity__row">
                    <Avatar handle={item.handle} size="sm" decorative />
                    <span className="team-activity__text">{item.text}</span>
                    <span className="team-activity__when">{activityWhen(item, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {project === undefined ? null : (
            <section className="team-home__section" aria-label="Project">
              <h2 className="team-home__head">Project</h2>
              <div className="card team-project">
                <span className="team-project__icon">
                  <Icon name="folder" />
                </span>
                <span className="team-project__text">
                  <span className="team-project__name">{project.name}</span>
                  <span className="team-project__ref">{project.baseRef}</span>
                </span>
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}

function rowKey(item: WaitingItem): string {
  return item.kind === 'handoff' ? item.handoff.id : item.pane.terminalId
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
      <li className="card home-card home-card--handoff" title={handoff.note}>
        <Avatar handle={from} size="md" decorative />
        <span className="home-card__text">
          <span className="home-card__title">
            <span className="home-card__name">{handoff.worktreeName}</span>
          </span>
          <span className="home-card__line">
            {from} handed this to you · {agoLabel(Math.max(0, now - handoff.at))}
          </span>
        </span>
        <span className="home-card__actions">
          <Button variant="primary" size="sm" onClick={() => void takeHandoff(projectId, handoff.id)}>
            Take
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void dismiss(projectId, handoff.id)}>
            Dismiss
          </Button>
        </span>
      </li>
    )
  }
  return (
    <li className="card home-card home-card--asking">
      <Avatar handle={item.handle} size="md" decorative />
      <span className="home-card__text">
        <span className="home-card__title">
          <span className="home-card__name">
            {item.handle} · {item.worktree}
          </span>
          <StatusPill state="asking" />
        </span>
        {item.pane.evidence === null ? null : <span className="home-card__line">{item.pane.evidence}</span>}
      </span>
      <span className="home-card__actions">
        <AnswerButtons
          terminalId={item.pane.terminalId}
          choices={item.pane.choices ?? []}
          className="team-answers"
          onChoose={(choice) => void answerTeammatePane(projectId, item.pane, choice)}
        />
        <OpenPane projectId={projectId} pane={item.pane} />
      </span>
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
  const answerTeammatePane = useWorkspaceStore((state) => state.answerTeammatePane)
  const shown = member.worktrees.slice(0, WORKTREES_SHOWN)
  const folded = member.worktrees.length - shown.length
  return (
    <li className={`team-member team-member--${member.presence}`}>
      <Avatar handle={member.handle} size="lg" presence={avatarPresence(member.presence)} decorative />
      <div className="team-member__body">
        <p className="team-member__line">
          <span className="team-member__handle">{member.handle}</span>
          <span className={`team-member__presence team-member__presence--${member.presence}`}>
            {presenceLabel(member, now)}
          </span>
        </p>
        {shown.length === 0 ? null : (
          <ul className="team-member__worktrees">
            {shown.map((worktree) => {
              const { pane } = worktree
              const asking = !worktree.own && worktree.tone === 'waiting' && pane?.choices !== undefined
              return (
                <li key={worktree.id} className="team-member__worktree">
                  <WorktreeButton worktree={worktree} projectId={projectId} handle={member.handle} />
                  {asking && pane !== undefined ? (
                    <span className="home-card__actions">
                      <AnswerButtons
                        terminalId={pane.terminalId}
                        choices={pane.choices ?? []}
                        className="team-answers"
                        onChoose={(choice) => void answerTeammatePane(projectId, pane, choice)}
                      />
                      <OpenPane projectId={projectId} pane={pane} />
                    </span>
                  ) : worktree.branch === undefined ? null : (
                    <span className="team-worktree__branch">{worktree.branch}</span>
                  )}
                </li>
              )
            })}
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
      {worktree.word === null ? null : (
        <StatusPill state={paneState(worktree.tone, worktree.word)} label={worktree.word} />
      )}
      <span className="team-worktree__name">{worktree.name}</span>
    </button>
  )
}

function OpenPane({ projectId, pane }: { projectId: string; pane: TeammatePaneRow }): React.JSX.Element {
  const watch = useWatch(projectId)
  return (
    <Button variant="ghost" size="sm" onClick={() => watch(pane)}>
      Open
    </Button>
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
