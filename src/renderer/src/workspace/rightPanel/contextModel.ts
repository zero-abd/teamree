// What the ledger says about one worktree, and about every task in a project, from `memory.list`.

import { matchesGlob } from '@shared/globs'
import type { ProjectMemory } from '@shared/ledgerMethods'
import type { MemoryNote } from '@shared/memory'

/** One task's claims, decisions and open questions. */
export type TaskContext = { worktreeId: string; claims: string[]; notes: MemoryNote[] }

export type WorktreeContext = {
  claims: string[]
  notes: MemoryNote[]
  /** Other tasks, with only the claims and decisions that touch this one's paths or claims. */
  siblings: TaskContext[]
}

/** Two globs, or a glob and a path, that can name the same file. */
export function globsMeet(a: string, b: string): boolean {
  return a === b || matchesGlob(a, b) || matchesGlob(b, a)
}

function shown(note: MemoryNote): boolean {
  return note.kind === 'decision' || (note.kind === 'question' && note.open === true)
}

function notesOf(memory: ProjectMemory, worktreeId: string): MemoryNote[] {
  return memory.notes.filter((note) => note.worktreeId === worktreeId && shown(note))
}

export function worktreeContext(memory: ProjectMemory | undefined, worktreeId: string): WorktreeContext {
  const own = memory?.worktrees.find((row) => row.worktreeId === worktreeId)
  if (memory === undefined || own === undefined) {
    return { claims: [], notes: memory === undefined ? [] : notesOf(memory, worktreeId), siblings: [] }
  }
  const mine = [...own.touched, ...own.claims]
  const touches = (glob: string): boolean => mine.some((path) => globsMeet(path, glob))
  const siblings = memory.worktrees.flatMap((row) => {
    if (row.worktreeId === worktreeId) return []
    const claims = row.claims.filter(touches)
    const notes = notesOf(memory, row.worktreeId).filter(
      (note) => note.kind === 'decision' && (note.paths ?? []).some(touches)
    )
    return claims.length === 0 && notes.length === 0 ? [] : [{ worktreeId: row.worktreeId, claims, notes }]
  })
  return { claims: [...own.claims], notes: notesOf(memory, worktreeId), siblings }
}

/** Every live task with a claim or a note, in the ledger's order. */
export function projectContext(memory: ProjectMemory | undefined): TaskContext[] {
  if (memory === undefined) return []
  return memory.worktrees.flatMap((row) => {
    const notes = notesOf(memory, row.worktreeId)
    return row.claims.length === 0 && notes.length === 0
      ? []
      : [{ worktreeId: row.worktreeId, claims: [...row.claims], notes }]
  })
}
