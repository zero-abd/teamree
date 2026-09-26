// A note captured from the menu bar: a dated section appended to NOTES.md, the page New Markdown
// opens, at the root of the project's checkout or of the worktree it is attached to.

import { join } from 'node:path'
import type { Project, Worktree } from '../../shared/entities'
import { DEFAULT_MARKDOWN_PATH } from '../../shared/filePane'
import { readWorktreeFile, writeWorktreeFile } from '../files/worktreeFile'

export type QuickNote = { projectId: string; worktreeId: string | null; text: string }

export type QuickNoteContext = {
  projects: { id: string; name: string }[]
  /** Preselected: the last project a note went to, else the window's, else the first. */
  projectId: string | null
  /** The worktree in front in the window, offered as the note's home. */
  worktree: { id: string; name: string; projectId: string } | null
}

export function quickNoteContext(input: {
  projects: readonly Pick<Project, 'id' | 'name'>[]
  worktrees: readonly Pick<Worktree, 'id' | 'name' | 'projectId'>[]
  lastProjectId?: string | undefined
  activeWorktreeId: string | null
}): QuickNoteContext {
  const active = input.worktrees.find((worktree) => worktree.id === input.activeWorktreeId)
  const known = (id: string | undefined): id is string => input.projects.some((project) => project.id === id)
  const projectId = known(input.lastProjectId)
    ? input.lastProjectId
    : known(active?.projectId)
      ? active.projectId
      : (input.projects[0]?.id ?? null)
  return {
    projects: input.projects.map(({ id, name }) => ({ id, name })),
    projectId,
    worktree: active === undefined ? null : { id: active.id, name: active.name, projectId: active.projectId }
  }
}

/** The note as sent over IPC, rebuilt field by field; null for anything else or an empty note. */
export function readQuickNote(value: unknown): QuickNote | null {
  if (typeof value !== 'object' || value === null) return null
  const { projectId, worktreeId, text } = value as Record<string, unknown>
  if (typeof projectId !== 'string' || projectId === '') return null
  if (worktreeId !== null && typeof worktreeId !== 'string') return null
  if (typeof text !== 'string' || text.trim() === '') return null
  return { projectId, worktreeId, text }
}

/** The checkout a note lands in: an attached worktree's when it belongs to the project, else the project's. */
export function noteCheckout(
  project: Pick<Project, 'id' | 'path'>,
  worktree: Pick<Worktree, 'projectId' | 'path'> | undefined
): string {
  return worktree?.projectId === project.id ? worktree.path : project.path
}

/** `existing` with one `## date time` section added at the end, in the file's own line endings. */
export function appendNote(existing: string, text: string, at: Date): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const body = text.trim().split(/\r?\n/).join(eol)
  const section = `## ${stamp(at)}${eol}${eol}${body}${eol}`
  if (existing === '') return section
  const gap = existing.endsWith(`${eol}${eol}`) ? '' : existing.endsWith(eol) ? eol : `${eol}${eol}`
  return `${existing}${gap}${section}`
}

function stamp(at: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/** Appends the note to the checkout's NOTES.md and answers where that is. */
export async function saveQuickNote(input: { checkout: string; text: string; at: Date }): Promise<string> {
  const where = { worktreeId: input.checkout, worktreePath: input.checkout, path: DEFAULT_MARKDOWN_PATH }
  const file = await readWorktreeFile(where)
  await writeWorktreeFile({
    ...where,
    content: appendNote(file.content, input.text, input.at),
    ...(file.encoding === undefined ? {} : { encoding: file.encoding }),
    // A save in between refuses this write rather than being overwritten by it.
    expectedModifiedAt: file.modifiedAt
  })
  return join(input.checkout, DEFAULT_MARKDOWN_PATH)
}
