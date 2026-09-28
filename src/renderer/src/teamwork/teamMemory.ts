// What this window has seen of teammates between presence reads: when each was last online, when it
// watched a worktree appear, finish and land, and the offers taken here. This machine's clock only.

import { teammatesHeard, type TeammatePresence } from '@shared/entities'
import type { PeerHandoff } from '@shared/tasks'

export type TeamMemory = {
  /** By public key: the last read that had them connected, or the read that said they had gone. */
  lastOnline: Map<string, number>
  /** By worktree id: the arrival of the snapshot that first said landed. */
  landedAt: Map<string, number>
  /** By worktree id: the arrival of the snapshot that first listed it. */
  startedAt: Map<string, number>
  /** By worktree id: the arrival of the snapshot that first said done or failed. */
  finishedAt: Map<string, { at: number; failed: boolean }>
  /** By handoff id: offers taken here, which the runtime stops listing once taken. */
  taken: Map<string, { projectId: string; handoff: PeerHandoff; at: number }>
}

export const newTeamMemory = (): TeamMemory => ({
  lastOnline: new Map(),
  landedAt: new Map(),
  startedAt: new Map(),
  finishedAt: new Map(),
  taken: new Map()
})

export function observeTeammates(
  memory: TeamMemory,
  previous: Readonly<Record<string, TeammatePresence>>,
  next: Readonly<Record<string, TeammatePresence>>,
  now: number
): void {
  for (const [projectId, presence] of Object.entries(next)) {
    const read = teammatesHeard(presence)
    if (read === undefined) continue
    const before = teammatesHeard(previous[projectId])
    for (const teammate of read.teammates) {
      const was = before?.teammates.find((entry) => entry.publicKey === teammate.publicKey)
      if (teammate.connected || was?.connected === true) memory.lastOnline.set(teammate.publicKey, now)
    }
    for (const worktree of read.worktrees) {
      const prior = before?.worktrees.find((entry) => entry.id === worktree.id)
      // New only beside a picture of the same teammate from before: their first snapshot lists old work too.
      const heardBefore = before?.teammates.some((entry) => entry.handle === worktree.handle && entry.heardAt !== null)
      if (prior === undefined && heardBefore === true && !memory.startedAt.has(worktree.id)) {
        memory.startedAt.set(worktree.id, worktree.heardAt)
      }
      const finished = worktree.stage === 'done' || worktree.stage === 'failed'
      if (finished && prior !== undefined && prior.stage !== worktree.stage && !memory.finishedAt.has(worktree.id)) {
        memory.finishedAt.set(worktree.id, { at: worktree.heardAt, failed: worktree.stage === 'failed' })
      }
      if (worktree.stage !== 'landed' || memory.landedAt.has(worktree.id)) continue
      // Only after a read with git details (`ahead`) that was not landed: a first snapshot carries none,
      // and a worktree first seen landed landed at a time nobody here knows.
      if (prior?.ahead !== undefined && prior.stage !== 'landed') memory.landedAt.set(worktree.id, worktree.heardAt)
    }
  }
}

/** The window's memory, fed from the store for as long as the window lives. */
export const teamMemory = newTeamMemory()

export function rememberTeammates(store: {
  getState: () => { teammates: Record<string, TeammatePresence> }
  subscribe: (listener: (state: { teammates: Record<string, TeammatePresence> }) => void) => () => void
}): () => void {
  let previous = store.getState().teammates
  observeTeammates(teamMemory, {}, previous, Date.now())
  return store.subscribe((state) => {
    if (state.teammates === previous) return
    observeTeammates(teamMemory, previous, state.teammates, Date.now())
    previous = state.teammates
  })
}
