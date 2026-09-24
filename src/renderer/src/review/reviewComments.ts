// A review comment on some lines, as text an agent reads, and the panes it can be typed into.

import type { Terminal } from '@shared/entities'
import type { PatchLine } from '@shared/patch'
import { paneAgent } from '../sidebar/agentRows'

export type QuotedLine = Pick<PatchLine, 'kind' | 'text' | 'oldNumber' | 'newNumber'>

export type ReviewComment = { path: string; lines: QuotedLine[]; note: string }

/** `src/math.ts:9-11`, by the file after the change unless none of the lines survive it. */
export function lineRef(comment: ReviewComment): string {
  const after = comment.lines.flatMap((line) => (line.newNumber === null ? [] : [line.newNumber]))
  const numbers = after.length > 0 ? after : comment.lines.flatMap((line) => line.oldNumber ?? [])
  if (numbers.length === 0) return comment.path
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  return first === last ? `${comment.path}:${first}` : `${comment.path}:${first}-${last}`
}

/** The reference, the lines fenced (as a diff when any changed), then the note. */
export function commentText(comment: ReviewComment): string {
  const changed = comment.lines.some((line) => line.kind !== 'context')
  const body = comment.lines.map((line) => (changed ? `${SIGN[line.kind]}${line.text}` : line.text)).join('\n')
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const note = comment.note.trim()
  return [lineRef(comment), `${fence}${changed ? 'diff' : ''}`, body, fence, ...(note === '' ? [] : [note])].join('\n')
}

const SIGN = { added: '+', removed: '-', context: ' ' } as const

/** One message for any number of comments. */
export function commentMessage(comments: readonly ReviewComment[]): string {
  return comments.map(commentText).join('\n\n')
}

/** Bracketed paste: an agent's prompt takes the newlines inside as text rather than as Return. */
export function pasted(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

/** The worktree's running panes with an agent in front, in the order they were opened. */
export function agentTargets(terminals: Readonly<Record<string, Terminal>>, worktreeId: string): Terminal[] {
  return Object.values(terminals).filter(
    (terminal) => terminal.worktreeId === worktreeId && terminal.running && paneAgent(terminal) !== undefined
  )
}
