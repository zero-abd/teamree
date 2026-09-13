// What the palette offers, and how typing narrows it.
//
// Kept apart from the component because the interesting part is not the list,
// it is the ranking: with twenty worktrees open, a palette that matches the
// right thing third is a palette nobody uses twice.

import type { Project, Worktree } from '@shared/entities'

export type PaletteAction =
  | 'new-worktree'
  | 'new-terminal'
  | 'split-right'
  | 'split-down'
  | 'toggle-changes'
  | 'toggle-sidebar'
  | 'open-dashboard'
  | 'add-project'

export type PaletteItem =
  /** Jump to a worktree. */
  | { kind: 'worktree'; id: string; label: string; hint: string; detail: string; search: string }
  /** Run something. */
  | { kind: 'action'; id: PaletteAction; label: string; hint: string; detail: string; search: string }

export type PaletteContext = {
  worktrees: readonly Worktree[]
  projects: readonly Project[]
  activeWorktreeId: string | null
  /** Shortcut labels, so the palette shows the key that does the same thing. */
  hintFor: (action: PaletteAction) => string
}

/**
 * Actions come after worktrees. Jumping is what the palette is opened for nine
 * times in ten, and an action typed by name still sorts to the top once its
 * letters are in the query.
 */
export function buildPaletteItems(context: PaletteContext): PaletteItem[] {
  const projectName = new Map(context.projects.map((project) => [project.id, project.name]))

  const worktrees: PaletteItem[] = context.worktrees
    .filter((worktree) => worktree.id !== context.activeWorktreeId)
    .map((worktree) => {
      const project = projectName.get(worktree.projectId) ?? ''
      return {
        kind: 'worktree',
        id: worktree.id,
        label: worktree.name,
        hint: worktree.branch,
        detail: worktree.state === 'ready' ? project : `${project} · ${worktree.state}`,
        // Everything you might reach for it by, in one string: a branch name is
        // often the only part a person remembers.
        search: `${worktree.name} ${worktree.branch} ${project}`
      }
    })

  const actions: PaletteItem[] = ACTIONS.map((action) => ({
    kind: 'action',
    id: action.id,
    label: action.label,
    hint: context.hintFor(action.id),
    detail: 'Action',
    search: `${action.label} ${action.keywords}`
  }))

  return [...worktrees, ...actions]
}

const ACTIONS: readonly { id: PaletteAction; label: string; keywords: string }[] = [
  { id: 'new-worktree', label: 'New task', keywords: 'create worktree branch start agent' },
  { id: 'new-terminal', label: 'New terminal', keywords: 'shell pane open' },
  { id: 'split-right', label: 'Split right', keywords: 'pane vertical column' },
  { id: 'split-down', label: 'Split down', keywords: 'pane horizontal row' },
  { id: 'toggle-changes', label: 'Show changes', keywords: 'diff git status files review' },
  {
    id: 'open-dashboard',
    label: 'All panes',
    keywords: 'agents dashboard overview attention waiting failed working everywhere'
  },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', keywords: 'hide show projects' },
  { id: 'add-project', label: 'Add project', keywords: 'repository repo folder clone' }
]

/**
 * Subsequence matching, scored by how the match sits rather than whether it
 * exists. Three things earn points, in the order a person would rank them: the
 * whole query appearing together, a match starting a word, and letters landing
 * next to each other. Everything else is a tie broken by the shorter label,
 * because the shorter one is more likely to be what was meant.
 *
 * Returns null when the letters are not all there, in order.
 */
export function score(text: string, query: string): number | null {
  if (query === '') return 0
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()

  const contiguous = haystack.indexOf(needle)
  if (contiguous !== -1) {
    // A whole-query hit beats any scattered one, and one at a word boundary
    // beats a hit buried mid-word.
    return 1000 + (isWordStart(haystack, contiguous) ? 200 : 0) - contiguous
  }

  let points = 0
  let at = 0
  let previous = -2
  for (const letter of needle) {
    if (letter === ' ') continue
    const found = nextOccurrence(haystack, letter, at)
    if (found === -1) return null
    if (found === previous + 1) points += 12
    if (isWordStart(haystack, found)) points += 20
    points -= Math.min(found - at, 8)
    previous = found
    at = found + 1
  }
  return points
}

/**
 * The next place this letter could match, preferring one that starts a word.
 *
 * Taking the first occurrence outright is the obvious implementation and the
 * wrong one: "nw" against "New worktree" would match the w inside "New" and
 * score no better than "now here", when an initialism is precisely how a
 * palette gets used.
 */
function nextOccurrence(haystack: string, letter: string, from: number): number {
  const first = haystack.indexOf(letter, from)
  if (first === -1) return -1
  for (let index = first; index !== -1; index = haystack.indexOf(letter, index + 1)) {
    if (isWordStart(haystack, index)) return index
  }
  return first
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const before = text[index - 1] as string
  return before === ' ' || before === '/' || before === '-' || before === '_' || before === '.'
}

/**
 * The list as typed narrows it. Ties keep the order they were built in, so an
 * empty query shows worktrees first and the list does not reshuffle itself
 * under the cursor as someone types and deletes a character.
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const trimmed = query.trim()
  if (trimmed === '') return [...items]

  return items
    .map((item, index) => ({ item, index, points: score(item.search, trimmed) }))
    .filter((row): row is { item: PaletteItem; index: number; points: number } => row.points !== null)
    .sort(
      (left, right) =>
        right.points - left.points || left.item.label.length - right.item.label.length || left.index - right.index
    )
    .map((row) => row.item)
}

/** Wraps around at both ends, because a palette with three rows is a ring. */
export function moveSelection(count: number, current: number, delta: number): number {
  if (count === 0) return 0
  return (current + delta + count) % count
}
