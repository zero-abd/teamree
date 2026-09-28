// The team as its home page reads it: who is on it and what their agents are doing, what waits on
// you, and what happened lately. Built from the roster, presence, handoffs and notes already here.

import {
  teamworkFacts,
  teammatesHeard,
  type MemberList,
  type TeammatePresence,
  type TeamworkStatus
} from '@shared/entities'
import type { SharedNoteSummary } from '@shared/sharedNote'
import type { PeerHandoff, TaskStage, TeamworkHandoffs } from '@shared/tasks'
import type { PeerReviewRequest, TeamworkReviewRequests } from '@shared/teammateReview'
import { agoLabel, type DotTone } from '../sidebar/agentRows'
import { teammateRows, teammateWord, twinNames, type TeammatePaneRow } from '../sidebar/teammateRows'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'
import type { TeamMemory } from './teamMemory'

export type { TeamMemory } from './teamMemory'

export type MemberPresence = 'you' | 'online' | 'away' | 'unseen'

export type MemberWorktree = {
  id: string
  name: string
  /** Only where another of the same person's worktrees has this name. */
  branch?: string
  /** What its agents are doing, in the sidebar's words; null for a worktree with nothing running. */
  word: string | null
  tone: DotTone | null
  /** The teammate's pane a click opens (`pickPane`); absent for your own and for one with no panes. */
  pane?: TeammatePaneRow
  own: boolean
}

export type TeamMember = {
  handle: string
  publicKey: string
  isSelf: boolean
  presence: MemberPresence
  /** This machine's clock; only for `away`. */
  lastSeenAt: number | null
  worktrees: MemberWorktree[]
}

/** One of your own worktrees as the caller reads it from the panes; `stage` from a landing or its report, as a teammate's is. */
export type OwnWorktree = { id: string; name: string; tone: DotTone | null; stage?: TaskStage }

const PRESENCE_ORDER: Record<MemberPresence, number> = { you: 0, online: 1, away: 2, unseen: 3 }

export function teamMembers(input: {
  list: MemberList | undefined
  presence: TeammatePresence | undefined
  status: TeamworkStatus | undefined
  own: readonly OwnWorktree[]
  memory: Pick<TeamMemory, 'lastOnline'>
  now: number
}): TeamMember[] {
  const heard = teammatesHeard(input.presence)
  const links = teamworkFacts(input.status)?.links ?? []
  const rows = teammateRows(heard?.worktrees ?? [], input.now)
  const people =
    input.list?.members.map(({ handle, publicKey, isSelf }) => ({ handle, publicKey, isSelf })) ??
    (heard?.teammates ?? []).map(({ handle, publicKey }) => ({ handle, publicKey, isSelf: false }))

  return people
    .map((person): TeamMember => {
      if (person.isSelf) {
        const worktrees = input.own
          .map(({ stage, ...worktree }) => ({
            ...worktree,
            word: teammateWord(stage, worktree.tone),
            own: true
          }))
          .sort((a, b) => urgency(a) - urgency(b))
        return { ...person, presence: 'you', lastSeenAt: null, worktrees }
      }
      const standing = heard?.teammates.find((entry) => entry.publicKey === person.publicKey)
      const online = isOnline(person.publicKey, heard, links)
      const lastSeenAt = online ? null : (input.memory.lastOnline.get(person.publicKey) ?? standing?.heardAt ?? null)
      const theirs = rows.filter((row) => row.handle === person.handle)
      const twins = twinNames(theirs.map((row) => row.name))
      const worktrees = theirs
        .map((row) => ({
          id: row.id,
          name: row.name,
          ...(twins.has(row.name) && row.branch !== undefined ? { branch: row.branch } : {}),
          word: row.word,
          tone: row.tone,
          ...(pickPane(row.panes) === undefined ? {} : { pane: pickPane(row.panes) }),
          own: false
        }))
        .sort((a, b) => urgency(a) - urgency(b))
      return {
        ...person,
        presence: online ? 'online' : lastSeenAt === null ? 'unseen' : 'away',
        lastSeenAt,
        worktrees
      }
    })
    .sort((a, b) => PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence] || a.handle.localeCompare(b.handle))
}

/** Teammates online, never you: presence once heard, else connected links. The page head, the rail and the status bar all say it. */
export function onlineCount(presence: TeammatePresence | undefined, status: TeamworkStatus | undefined): number {
  const heard = teammatesHeard(presence)
  if (heard !== undefined) return heard.teammates.filter((teammate) => teammate.connected).length
  return (teamworkFacts(status)?.links ?? []).filter((link) => link.phase === 'connected').length
}

/** Presence first; a live link says so when no presence has been heard. */
function isOnline(
  publicKey: string,
  heard: ReturnType<typeof teammatesHeard>,
  links: readonly { publicKey: string; phase: string }[]
): boolean {
  const standing = heard?.teammates.find((entry) => entry.publicKey === publicKey)
  return standing?.connected ?? links.find((entry) => entry.publicKey === publicKey)?.phase === 'connected'
}

/** Asking, then working, then the rest, merged last: what their agents are doing now comes first. */
function urgency(worktree: MemberWorktree): number {
  if (worktree.word === 'asking' || worktree.tone === 'waiting') return 0
  if (worktree.word === 'working' || worktree.tone === 'working') return 1
  return worktree.word === 'merged' ? 3 : 2
}

/** The pane a click should open: one asking, else one working, else the first. */
function pickPane(panes: readonly TeammatePaneRow[]): TeammatePaneRow | undefined {
  return (
    panes.find((pane) => pane.activity === 'waiting') ?? panes.find((pane) => pane.activity === 'working') ?? panes[0]
  )
}

export function presenceLabel(member: TeamMember, now: number): string {
  switch (member.presence) {
    case 'you':
      return 'you'
    case 'online':
      return 'online'
    case 'unseen':
      return 'not seen yet'
    case 'away':
      return member.lastSeenAt === null ? 'away' : `away · last seen ${agoLabel(now - member.lastSeenAt)}`
  }
}

export type WaitingItem =
  | { kind: 'handoff'; handoff: PeerHandoff }
  | { kind: 'review'; request: PeerReviewRequest }
  | { kind: 'reviewing'; request: PeerReviewRequest }
  | { kind: 'asking'; handle: string; worktree: string; pane: TeammatePaneRow }

/**
 * Handoffs to take, newest first, then reviews asked of you, oldest first, then teammates' agents asking
 * with answers this machine may send, then reviews you opened and have not sent.
 */
export function waitingOnYou(input: {
  handoffs: TeamworkHandoffs | undefined
  reviewRequests?: TeamworkReviewRequests | undefined
  presence: TeammatePresence | undefined
  now: number
}): WaitingItem[] {
  const handoffs = [...(input.handoffs?.incoming ?? [])]
    .sort((a, b) => b.at - a.at)
    .map((handoff): WaitingItem => ({ kind: 'handoff', handoff }))
  const asking = teammateRows(teammatesHeard(input.presence)?.worktrees ?? [], input.now).flatMap((row) =>
    row.panes
      .filter((pane) => pane.activity === 'waiting' && pane.choices !== undefined)
      .map((pane): WaitingItem => ({ kind: 'asking', handle: row.handle, worktree: row.name, pane }))
  )
  const requests = [...(input.reviewRequests?.incoming ?? [])].sort((a, b) => a.at - b.at)
  const reviews = requests.filter((request) => request.opened !== true)
  const reviewing = requests.filter((request) => request.opened === true)
  return [
    ...handoffs,
    ...reviews.map((request): WaitingItem => ({ kind: 'review', request })),
    ...asking,
    ...reviewing.map((request): WaitingItem => ({ kind: 'reviewing', request }))
  ]
}

export type ActivityItem = {
  key: string
  /** Whose avatar goes beside it. */
  handle: string
  text: string
  at: number
  /** Known to the day only, as a member file records its date. */
  day: boolean
}

const MAX_ACTIVITY = 20

/** Newest first. Your own lines say "you". */
export function teamActivity(input: {
  list: MemberList | undefined
  handoffs: TeamworkHandoffs | undefined
  notes: readonly SharedNoteSummary[]
  presence: TeammatePresence | undefined
  memory: Pick<TeamMemory, 'landedAt' | 'startedAt' | 'finishedAt' | 'taken'>
  projectId: string
}): ActivityItem[] {
  const self = input.list?.self.handle ?? 'you'
  const items: ActivityItem[] = []
  for (const member of input.list?.members ?? []) {
    const at = dayOf(member.addedAt)
    if (at === null) continue
    const who = member.isSelf ? 'you' : member.handle
    items.push({ key: `joined:${member.publicKey}`, handle: member.handle, text: `${who} joined`, at, day: true })
  }
  const taken = [...input.memory.taken.values()].filter((entry) => entry.projectId === input.projectId)
  for (const { handoff, at } of taken) {
    items.push({ key: `took:${handoff.id}`, handle: self, text: `you took ${handoff.worktreeName}`, at, day: false })
  }
  const offered = [...(input.handoffs?.incoming ?? []), ...taken.map((entry) => entry.handoff)]
  for (const handoff of offered.filter(
    (entry, index) => offered.findIndex((other) => other.id === entry.id) === index
  )) {
    const from = handoff.from ?? 'a teammate'
    items.push({
      key: `handoff:${handoff.id}`,
      handle: from,
      text: `${from} handed you ${handoff.worktreeName}`,
      at: handoff.at,
      day: false
    })
  }
  for (const handoff of input.handoffs?.outgoing ?? []) {
    items.push({
      key: `handoff:${handoff.id}`,
      handle: self,
      text: `you handed ${handoff.worktreeName} to ${handoff.to}`,
      at: handoff.at,
      day: false
    })
    if (handoff.takenAt !== undefined) {
      items.push({
        key: `took:${handoff.id}`,
        handle: handoff.to,
        text: `${handoff.to} took ${handoff.worktreeName}`,
        at: handoff.takenAt,
        day: false
      })
    }
  }
  for (const note of input.notes) {
    items.push({
      key: `note:${note.shareId}`,
      handle: note.handle,
      text: `${note.handle} shared ${note.title}`,
      at: note.receivedAt,
      day: false
    })
  }
  for (const worktree of teammatesHeard(input.presence)?.worktrees ?? []) {
    const name = worktreeDisplay(worktree).title
    const said = (kind: string, text: string, at: number | undefined): void => {
      if (at !== undefined) items.push({ key: `${kind}:${worktree.id}`, handle: worktree.handle, text, at, day: false })
    }
    said('started', `${worktree.handle} started ${name}`, input.memory.startedAt.get(worktree.id))
    const finished = input.memory.finishedAt.get(worktree.id)
    said('finished', `${worktree.handle} ${finished?.failed === true ? 'failed' : 'finished'} ${name}`, finished?.at)
    if (worktree.stage === 'landed')
      said('merged', `${worktree.handle} merged ${name}`, input.memory.landedAt.get(worktree.id))
  }
  return items.sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY)
}

export function activityWhen(item: ActivityItem, now: number): string {
  if (!item.day) return agoLabel(Math.max(0, now - item.at))
  const today = startOfDay(now)
  if (item.at >= today) return 'today'
  if (item.at >= startOfDay(today - 1)) return 'yesterday'
  return new Date(item.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * One line when the relay itself is the reason nobody is here. Nothing for a teammate who is
 * simply not online: that is a presence, not a fault.
 */
export function teamLine(status: TeamworkStatus | undefined): string | null {
  const links = teamworkFacts(status)?.links ?? []
  if (links.length === 0 || links.some((link) => link.phase === 'connected')) return null
  if (links.some((link) => link.phase === 'unreachable')) return 'Relay unreachable'
  if (links.every((link) => link.phase === 'refused')) return 'Handshake refused'
  return null
}

/** Local midnight of a member file's `YYYY-MM-DD`, or null for anything else. */
function dayOf(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (match === null) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
}

function startOfDay(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}
