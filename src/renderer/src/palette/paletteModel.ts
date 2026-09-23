// What the palette offers, and how typing narrows it.
//
// Kept apart from the component because the interesting part is not the list,
// it is the ranking: with twenty worktrees open, a palette that matches the
// right thing third is a palette nobody uses twice.

import type { CliStatus, InstalledAgent, Project, UpdateState, Worktree } from '@shared/entities'
import { cliActionLabel } from '../dialogs/cliInstallModel'
import { automaticUpdatesLabel } from '../updates/updateNotice'

export type PaletteAction =
  | 'new-worktree'
  | 'new-terminal'
  | 'split-right'
  | 'split-down'
  | 'toggle-changes'
  | 'toggle-sidebar'
  | 'open-dashboard'
  | 'add-project'
  | 'install-cli'
  | 'open-appearance'
  | 'open-settings'
  | 'open-help'
  | 'check-for-updates'
  | 'toggle-automatic-updates'

export type PaletteItem =
  /** Jump to a worktree. */
  | { kind: 'worktree'; id: string; label: string; hint: string; detail: string; search: string }
  /** Run something. */
  | { kind: 'action'; id: PaletteAction; label: string; hint: string; detail: string; search: string }
  /** Start one of the coding agents this machine has, in the worktree on
   * screen. `id` is the command to run, which is what starting one needs. */
  | { kind: 'agent'; id: string; label: string; hint: string; detail: string; search: string }

export type PaletteContext = {
  worktrees: readonly Worktree[]
  projects: readonly Project[]
  activeWorktreeId: string | null
  /** Coding agents found on this machine, as probed at startup. */
  agents: readonly InstalledAgent[]
  /**
   * The agent kind this machine's owner said they always use, if any. It only
   * decides which of the agent rows comes first.
   */
  defaultAgent: string
  /**
   * What the runtime knows about newer releases, or null before it has been
   * asked. Only the preference is read from it: it decides which way round the
   * toggle's label reads.
   */
  update: UpdateState | null
  /** Shortcut labels, so the palette shows the key that does the same thing. */
  hintFor: (action: PaletteAction) => string
  /**
   * How this machine's CLI link stands, which is what one of the actions below
   * is named after. Null until the first read has answered.
   */
  cli: CliStatus | null
}

/**
 * Actions come after worktrees. Jumping is what the palette is opened for nine
 * times in ten, and an action typed by name still sorts to the top once its
 * letters are in the query.
 *
 * The agents sit between the two: they act on the worktree in front of you,
 * which is nearer to jumping than to "add a project", and they are the only
 * rows here whose existence depends on the machine.
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

  const actions: PaletteItem[] = [...ACTIONS, ...updateActions(context)].map((action) => {
    // One action is named after a state rather than fixed, because "Put teamree
    // on my PATH" is the wrong sentence to offer somebody whose PATH already
    // has a teamree on it that leads nowhere. The keywords stay whatever the
    // list says: they are what somebody types looking for it, and they must not
    // move when the label does.
    const label = action.id === 'install-cli' ? cliActionLabel(context.cli) : action.label
    return {
      kind: 'action',
      id: action.id,
      label,
      hint: context.hintFor(action.id),
      detail: 'Action',
      search: `${label} ${action.keywords}`
    }
  })

  return [...worktrees, ...agentItems(context), ...actions]
}

/**
 * One row per agent this machine actually has, starting it in the worktree
 * already on screen.
 *
 * Built from the probe rather than from a list of names, because the palette
 * offering an agent nobody has installed is worse than offering none: the row
 * is a promise that pressing Return will do something. For the same reason
 * there are none of these until there is a ready worktree to start one in —
 * `startAgent` acts on the active worktree, and a checkout still being made
 * has no directory to run a shell in.
 *
 * The wording carries the whole distinction from "New task": both start an
 * agent, and only one of them does it here. Somebody who wants a fresh
 * checkout should not land on this row, and somebody looking at the worktree
 * they want the agent in should not be sent through a dialog that makes
 * another one.
 */
function agentItems(context: PaletteContext): PaletteItem[] {
  const active = context.worktrees.find((worktree) => worktree.id === context.activeWorktreeId)
  if (active === undefined || active.state !== 'ready') return []

  // The preferred one first, and the rest in the probe's own order behind it.
  // The palette is a keyboard surface: the row that is already under the cursor
  // when it opens is the one that gets pressed, so "the agent I always use"
  // being third is the same defect as the composer preselecting the wrong one.
  // A preference naming an agent this machine does not have moves nothing,
  // which is the same answer the composer gives.
  const preferred = context.agents.filter((agent) => agent.kind === context.defaultAgent)
  const rest = context.agents.filter((agent) => agent.kind !== context.defaultAgent)

  return [...preferred, ...rest].map((agent) => ({
    kind: 'agent',
    id: agent.command,
    label: `Start ${agent.command} in this worktree`,
    hint: active.name,
    detail: 'Opens a pane here',
    // "here" and "this worktree" are what somebody types when the distinction
    // from a new task is the thing they are unsure about. Short, in this order,
    // and without the word "agent": the matcher takes the first word-starting
    // letter it can, so every extra word is another place a query can be sent
    // past the word it meant — with "this" ahead of "here", typing "claude this
    // worktree" jumped the h to "here" and matched nothing at all. And "agents"
    // is how somebody reaches the all-panes view.
    search: `Start ${agent.command} here in this worktree pane`
  }))
}

/**
 * The two update rows, which are here rather than in the list below because one
 * of them says something different depending on how it is set.
 *
 * The preference has no other home — this app has no settings window, and a
 * window's worth of chrome for one boolean would be the wrong trade — so the
 * palette is where somebody who does not want to be told about releases goes to
 * say so. The card offers the same thing at the moment it matters.
 */
function updateActions(context: PaletteContext): { id: PaletteAction; label: string; keywords: string }[] {
  return [
    {
      id: 'check-for-updates',
      label: 'Check for updates',
      keywords: 'version release new upgrade download latest'
    },
    {
      id: 'toggle-automatic-updates',
      label: automaticUpdatesLabel(context.update),
      keywords: 'updates automatic quiet stop checking release version notify'
    }
  ]
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
  { id: 'add-project', label: 'Add project', keywords: 'repository repo folder clone' },
  // Two surfaces that are about the window rather than about a worktree, and
  // the palette is the one place somebody looks for a thing whose name they
  // know and whose location they do not. The keywords carry what people call
  // these rather than what this app calls them: nobody searches for "help"
  // when what they want is the key that splits a pane.
  {
    id: 'open-settings',
    label: 'Settings',
    keywords: 'preferences options config cli path relay start point font size updates reveal'
  },
  { id: 'open-help', label: 'Help', keywords: 'shortcuts keys keyboard worktree cli docs how what' },
  {
    id: 'open-appearance',
    label: 'Appearance',
    // Every word somebody might reach for it by, including the two spellings of
    // the one word this is mostly about.
    keywords: 'theme colour color dark black contrast accent ground palette settings preferences'
  },
  {
    id: 'install-cli',
    // Replaced at build time by `cliActionLabel` when the link is the problem
    // rather than its absence. This is the wording for the ordinary case.
    label: 'Put teamree on my PATH',
    keywords: 'cli command line terminal install link symlink usr local bin path agent broken fix dangling'
  }
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
