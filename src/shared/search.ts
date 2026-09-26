// Content search over one worktree or every worktree of a project. Merged into
// the contract through methods.ts; the hits arrive on a subscription.

import { z } from 'zod'

/** Most matching lines one search reports before it stops. */
export const MAX_SEARCH_HITS = 2000

/** How much of a matching line is sent, in characters; the rest is elided around the first match. */
export const SEARCH_LINE_CHARS = 240

const Id = z.string().min(1).max(256)

export type SearchOptions = { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }

export const SearchParams = {
  /** Exactly one of `worktreeId` and `projectId`; `include` takes globs, `!glob` excludes. */
  worktreeSearch: z
    .object({
      worktreeId: Id.optional(),
      projectId: Id.optional(),
      query: z.string().min(1).max(1000),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      wholeWord: z.boolean().optional(),
      include: z.array(z.string().trim().min(1).max(512)).max(32).optional(),
      limit: z.number().int().positive().max(MAX_SEARCH_HITS).optional()
    })
    .refine((params) => (params.worktreeId === undefined) !== (params.projectId === undefined), {
      message: 'names exactly one of worktreeId and projectId'
    })
} as const

/** One matching line; `ranges` are [start, end) into `text`, `column` is the first match's, 1-based, in the whole line. */
export type SearchLine = { line: number; column: number; text: string; ranges: Array<[number, number]> }

export type SearchFileHits = { worktreeId: string; path: string; lines: SearchLine[] }

export type SearchSummary = {
  matches: number
  /** The hit cap stopped it. */
  truncated: boolean
  timedOut: boolean
  elapsedMs: number
  engine: 'rg' | 'git'
  /** What an engine said when it failed, e.g. a bad regex; a search can fail in one worktree only. */
  error?: string
}

/** Events on a worktree.search subscription: batches of hits, then one `done`, then the stream ends. */
export type WorktreeSearchEvent = { type: 'hits'; files: SearchFileHits[] } | ({ type: 'done' } & SearchSummary)

type P = typeof SearchParams

export type SearchMethodContract = {
  'worktree.search': { params: z.infer<P['worktreeSearch']>; result: { subscription: string } }
}

/** The query as a JS pattern, for drawing matches; null when the engine's regex is not one JS reads. */
export function searchPattern(query: string, options: SearchOptions): RegExp | null {
  const source = options.regex === true ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bounded = options.wholeWord === true ? `\\b(?:${source})\\b` : source
  try {
    return new RegExp(bounded, options.caseSensitive === true ? 'g' : 'gi')
  } catch {
    return null
  }
}

/** A matching line as sent: its matches found, and clipped around the first when long. */
export function searchLine(line: number, raw: string, pattern: RegExp | null): SearchLine {
  const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const ranges: Array<[number, number]> = []
  if (pattern !== null) {
    pattern.lastIndex = 0
    for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
      if (found[0].length === 0) {
        pattern.lastIndex += 1
        continue
      }
      ranges.push([found.index, found.index + found[0].length])
      if (ranges.length >= 50) break
    }
  }
  const column = (ranges[0]?.[0] ?? 0) + 1
  if (text.length <= SEARCH_LINE_CHARS) return { line, column, text, ranges }

  const start = Math.max(0, (ranges[0]?.[0] ?? 0) - 40)
  const end = Math.min(text.length, start + SEARCH_LINE_CHARS)
  const lead = start > 0 ? '…' : ''
  const clipped = `${lead}${text.slice(start, end)}${end < text.length ? '…' : ''}`
  const shift = lead.length - start
  const kept = ranges
    .filter(([from]) => from < end)
    .map(([from, to]): [number, number] => [from + shift, Math.min(to, end) + shift])
  return { line, column, text: clipped, ranges: kept }
}
