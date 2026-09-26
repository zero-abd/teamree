// `project.context` for one worktree, filled by need: nothing at all unless a
// sibling overlaps, then own goal, parent goals, the overlaps and the decisions on them.

import {
  MAX_NOTE_PATHS,
  emptyProjectContext,
  type ContextSection,
  type ContextSibling,
  type MemoryNote,
  type ProjectContext
} from '../../shared/memory'
import { matchesGlob } from './globs'
import type { LedgerWorktree } from './ledgerStore'
import type { RankedOverlap } from './ranking'

const MAX_GOAL_CHARS = 160
const PATHS_PER_LINE = 8

export type BundleInput = {
  viewer: LedgerWorktree
  /** Nearest first. */
  ancestors: LedgerWorktree[]
  /** Ranked, from `rankOverlaps`. */
  overlaps: RankedOverlap[]
  /** Live worktrees the viewer may be told about: not its ancestors, descendants or fanned-out runs. */
  others: LedgerWorktree[]
  notes: MemoryNote[]
  budgetTokens: number
  sections?: ContextSection[]
  revision: number
}

type Item = { section: ContextSection; text: string; apply: (context: ProjectContext) => void }

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** A note naming no path touches nothing; one naming paths touches what its paths match. */
function noteTouches(note: MemoryNote, paths: readonly string[], claims: readonly string[]): boolean {
  return (note.paths ?? []).some(
    (notePath) =>
      paths.some((path) => matchesGlob(path, notePath)) ||
      claims.some((claim) => claim === notePath || matchesGlob(notePath, claim))
  )
}

export function buildBundle(input: BundleInput): ProjectContext {
  const { viewer } = input
  const context = { ...emptyProjectContext(viewer.id), revision: input.revision }
  const decisionsBy = new Map<string, MemoryNote[]>()
  for (const note of input.notes) {
    if (note.kind !== 'decision') continue
    decisionsBy.set(note.worktreeId, [...(decisionsBy.get(note.worktreeId) ?? []), note])
  }

  const siblings: { worktree: LedgerWorktree; overlap?: RankedOverlap; decisions: MemoryNote[] }[] = []
  const byId = new Map(input.others.map((worktree) => [worktree.id, worktree]))
  for (const overlap of input.overlaps) {
    const worktree = byId.get(overlap.worktreeId)
    if (worktree === undefined || !overlap.visible) continue
    siblings.push({ worktree, overlap, decisions: [] })
  }
  for (const worktree of input.others) {
    const decisions = (decisionsBy.get(worktree.id) ?? []).filter((note) =>
      noteTouches(note, viewer.touched, viewer.claims)
    )
    if (decisions.length === 0) continue
    const listed = siblings.find((row) => row.worktree.id === worktree.id)
    if (listed) listed.decisions = decisions
    else siblings.push({ worktree, decisions })
  }
  if (siblings.length === 0) return context

  const items: Item[] = []
  const goal = clip(viewer.goal || viewer.name)
  items.push({ section: 'self', text: `goal: ${goal}`, apply: (into) => (into.self.goal = goal) })
  if (viewer.claims.length > 0) {
    items.push({
      section: 'self',
      text: `claims: ${viewer.claims.join(', ')}`,
      apply: (into) => (into.self.claims = [...viewer.claims])
    })
  }
  input.ancestors.forEach((ancestor, index) => {
    const line = clip(ancestor.goal || ancestor.name)
    items.push({
      section: 'ancestors',
      text: `${index === 0 ? 'parent' : 'above'}: ${line}`,
      apply: (into) => into.ancestors.push({ worktreeId: ancestor.id, name: ancestor.name, goal: line })
    })
  })
  for (const sibling of siblings) items.push(siblingItem(sibling.worktree, sibling.overlap, sibling.decisions))

  const own = new Set([viewer.id, ...input.ancestors.map((ancestor) => ancestor.id)])
  for (const note of input.notes) {
    if (!own.has(note.worktreeId)) continue
    if (note.kind === 'decision') {
      const inherited = note.worktreeId !== viewer.id
      if (inherited && note.paths !== undefined && !noteTouches(note, viewer.touched, viewer.claims)) continue
      items.push({
        section: 'self',
        text: `decision: ${noteLine(note)}`,
        apply: (into) => into.self.decisions.push(note)
      })
    } else if (note.kind === 'question' && note.open === true && note.worktreeId === viewer.id) {
      items.push({
        section: 'questions',
        text: `question: ${note.text}`,
        apply: (into) => into.self.questions.push(note)
      })
    }
  }

  const lines: string[] = []
  const dropped = new Map<string, number>()
  let used = 0
  for (const item of items) {
    if (input.sections !== undefined && !input.sections.includes(item.section)) continue
    // A joining newline costs a character too.
    const cost = item.text.length + (lines.length > 0 ? 1 : 0)
    if (Math.ceil((used + cost) / 4) > input.budgetTokens) {
      dropped.set(item.section, (dropped.get(item.section) ?? 0) + 1)
      continue
    }
    used += cost
    lines.push(item.text)
    item.apply(context)
  }
  context.text = lines.join('\n')
  context.tokens = estimateTokens(context.text)
  context.truncated = [...dropped].map(([section, count]) => ({ section, dropped: count }))
  return context
}

function siblingItem(worktree: LedgerWorktree, overlap: RankedOverlap | undefined, decisions: MemoryNote[]): Item {
  const lines = [worktree.goal === '' ? `sibling ${worktree.name}` : `sibling ${worktree.name}: ${clip(worktree.goal)}`]
  const conflicts = overlap?.conflicts ?? []
  const claimed = (overlap?.claimed ?? []).filter((path) => !conflicts.includes(path))
  const plain = (overlap?.paths ?? []).filter((path) => !conflicts.includes(path) && !claimed.includes(path))
  if (conflicts.length > 0) lines.push(`  conflict: ${pathList(conflicts)}`)
  if (plain.length > 0) lines.push(`  overlap: ${pathList(plain)}`)
  if (claimed.length > 0) lines.push(`  claimed: ${pathList(claimed)}`)
  for (const note of decisions) lines.push(`  decision: ${noteLine(note)}`)

  const row: ContextSibling = {
    worktreeId: worktree.id,
    name: worktree.name,
    goal: clip(worktree.goal),
    state: worktree.state,
    owner: worktree.owner,
    overlap: (overlap?.paths ?? []).slice(0, MAX_NOTE_PATHS),
    decisions,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(claimed.length > 0 ? { claimed } : {})
  }
  return { section: 'siblings', text: lines.join('\n'), apply: (into) => into.siblings.push(row) }
}

function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, PATHS_PER_LINE).join(', ')
  return paths.length > PATHS_PER_LINE ? `${shown} (+${paths.length - PATHS_PER_LINE})` : shown
}

function noteLine(note: MemoryNote): string {
  return note.paths && note.paths.length > 0 ? `${note.text} (${note.paths.join(', ')})` : note.text
}

function clip(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length <= MAX_GOAL_CHARS ? line : `${line.slice(0, MAX_GOAL_CHARS - 1)}…`
}
