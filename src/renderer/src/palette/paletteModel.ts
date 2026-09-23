// What the palette offers, and how typing narrows and ranks it.

import {
  hasCheckout,
  type CliStatus,
  type InstalledAgent,
  type Project,
  type UpdateState,
  type Worktree
} from '@shared/entities'
import { fuzzyPathScore, matchTier } from '@shared/fuzzyPath'
import { cliActionLabel } from '../dialogs/cliInstallModel'
import type { WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { MENU_ORDER, menuLabel } from '../menu/menuBar'
import { automaticUpdatesLabel } from '../updates/updateNotice'

/** Every command this window has (derived from `WorkspaceCommand`, so none go missing) plus the palette's own rows. */
export type PaletteAction =
  | WorkspaceCommand
  | 'toggle-changes'
  | 'show-files'
  | 'add-project'
  | 'install-cli'
  | 'check-for-updates'
  | 'toggle-automatic-updates'

export type PaletteItem =
  /** Jump to a worktree. */
  | { kind: 'worktree'; id: string; label: string; hint: string; detail: string; search: string }
  /** Run something. */
  | { kind: 'action'; id: PaletteAction; label: string; hint: string; detail: string; search: string }
  /** Start a coding agent in the worktree on screen; `id` is the command to run. */
  | { kind: 'agent'; id: string; label: string; hint: string; detail: string; search: string }
  /** Open a file of the worktree on screen; `id` is its path. */
  | { kind: 'file'; id: string; label: string; hint: string; detail: string; search: string }

/** How many files ⌘P lists, and how many ⌘K adds under Files once the query is long enough to mean one. */
export const FILE_MODE_LIMIT = 50
export const FILES_IN_COMMANDS = 5
export const FILES_IN_COMMANDS_MIN_QUERY = 2

export type PaletteContext = {
  worktrees: readonly Worktree[]
  projects: readonly Project[]
  activeWorktreeId: string | null
  /** Coding agents found on this machine, as probed at startup. */
  agents: readonly InstalledAgent[]
  /** The agent kind the owner always uses; it only decides which agent row comes first. */
  defaultAgent: string
  /** What the runtime knows about releases, or null; only the preference is read, for the toggle's label. */
  update: UpdateState | null
  /** Shortcut labels, so the palette shows the key that does the same thing. */
  hintFor: (action: PaletteAction) => string
  /** How this machine's CLI link stands, which names one action. Null until first read. */
  cli: CliStatus | null
}

/**
 * Worktrees first (jumping is what the palette is for), then agents (they act on the worktree in
 * front), then actions; a typed action name still sorts to the top.
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
        detail: hasCheckout(worktree) ? project : `${project} · ${worktree.missing ? 'missing' : worktree.state}`,
        // A branch name is often the only part a person remembers.
        search: `${worktree.name} ${worktree.branch} ${project}`
      }
    })

  const actions: PaletteItem[] = [...commandActions(), ...ACTIONS, ...updateActions(context)].map((action) => {
    // Named after the link's state; the keywords stay fixed so a search does not move with the label.
    const label = action.id === 'install-cli' ? cliActionLabel(context.cli) : action.label
    return {
      kind: 'action',
      id: action.id,
      label,
      hint: context.hintFor(action.id),
      detail: '',
      search: `${label} ${action.keywords}`
    }
  })

  return [...worktrees, ...agentItems(context), ...actions]
}

/**
 * One row per agent the probe found, starting it in the ready worktree on screen; none until there is one.
 * Worded as "here" to keep it apart from "New task", which makes another checkout.
 */
function agentItems(context: PaletteContext): PaletteItem[] {
  const active = context.worktrees.find((worktree) => worktree.id === context.activeWorktreeId)
  if (active === undefined || !hasCheckout(active)) return []

  // The preferred agent first so it is under the cursor on open; an unknown preference moves nothing.
  const preferred = context.agents.filter((agent) => agent.kind === context.defaultAgent)
  const rest = context.agents.filter((agent) => agent.kind !== context.defaultAgent)

  return [...preferred, ...rest].map((agent) => ({
    kind: 'agent',
    id: agent.command,
    label: `Start ${agent.command} in this worktree`,
    hint: active.name,
    detail: '',
    // No "agent": the matcher takes the first word-start it can, and "this" before "here" once sent
    // "claude this worktree" past the h. "agents" reaches the all-panes view.
    search: `Start ${agent.command} here in this worktree pane`
  }))
}

/** The two update rows; the toggle's wording depends on the current preference. */
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

/** One row per command, in menu order, named by `menuLabel`; the palette keeps no wording of its own. */
function commandActions(): { id: PaletteAction; label: string; keywords: string }[] {
  return MENU_ORDER.map((command) => ({
    id: command,
    label: menuLabel(command),
    keywords: COMMAND_KEYWORDS[command]
  }))
}

/** What somebody types looking for each command. Total over the union, so a new command fails the build here. */
const COMMAND_KEYWORDS: Record<WorkspaceCommand, string> = {
  'new-worktree': 'new task create worktree branch start agent checkout',
  'new-terminal': 'new terminal shell pane open',
  'new-markdown': 'new markdown notes page document write md file',
  'close-pane': 'close pane kill stop shut terminal',
  'save-file': 'save file write disk edits',
  'save-all': 'save all files write disk edits',
  'find-in-pane': 'find search pane scrollback text',
  'split-right': 'split pane right vertical column',
  'split-down': 'split pane down horizontal row',
  'focus-previous-pane': 'focus previous pane back left',
  'focus-next-pane': 'focus next pane forward right',
  'select-next-pane': 'select next pane tab switch cycle',
  'select-previous-pane': 'select previous pane tab switch cycle back',
  'next-file-tab': 'next file tab column page switch',
  'previous-file-tab': 'previous file tab column page switch back',
  'expand-pane': 'maximize maximise expand pane full zoom',
  'previous-worktree': 'previous worktree up back',
  'next-worktree': 'next worktree down forward',
  'open-palette': 'go to worktree command palette search anything',
  'go-to-file': 'go to file open quick find path',
  'open-dashboard': 'all panes agents dashboard overview attention waiting failed working everywhere',
  'toggle-sidebar': 'toggle sidebar hide show projects',
  'toggle-right-panel': 'toggle right panel hide show files changes panes',
  // What people call the things on that page, not "settings".
  'open-settings': 'settings preferences options config cli path relay start point font size updates editor',
  // Both spellings; not "settings", which is the other page.
  'open-appearance': 'appearance theme colour color dark black contrast accent ground swatch',
  'commit-changes': 'commit changes diff git stage staged message files review',
  'push-worktree': 'push send remote origin upload publish branch ahead',
  'open-help': 'help shortcuts keys keyboard worktree cli docs how what',
  'bigger-text': 'bigger text font size zoom in larger increase terminal',
  'smaller-text': 'smaller text font size zoom out decrease terminal',
  'actual-size': 'actual size reset text font default zoom terminal'
}

/** The rows that are the palette's own, with no command and no menu item. */
const ACTIONS: readonly { id: PaletteAction; label: string; keywords: string }[] = [
  { id: 'toggle-changes', label: 'Show changes', keywords: 'diff git status files review changes' },
  { id: 'show-files', label: 'Show files', keywords: 'tree folder directory explorer browse open panel' },
  { id: 'add-project', label: 'Add project', keywords: 'add project repository repo folder clone' },
  {
    id: 'install-cli',
    // Replaced by `cliActionLabel` when the link is the problem rather than its absence.
    label: 'Put teamree on my PATH',
    keywords: 'cli command line terminal install link symlink usr local bin path agent broken fix dangling'
  }
]

/**
 * How well this row answers the query, or null when any typed word is absent (as a run, or as the
 * initials of consecutive words). Ranks whole-query > word start > early > initialism.
 */
export function score(text: string, query: string): number | null {
  const trimmed = query.trim()
  if (trimmed === '') return 0
  const haystack = text.toLowerCase()

  let points = 0
  for (const word of trimmed.toLowerCase().split(/\s+/)) {
    const found = place(haystack, word)
    if (found === null) return null
    points += found
  }

  // The whole query in one piece beats any arrangement of its words.
  const whole = haystack.indexOf(trimmed.toLowerCase())
  if (whole !== -1) points += 1000 + (isWordStart(haystack, whole) ? 200 : 0) - Math.min(whole, 100)

  return points
}

/** What one word of the query is worth against this text, or null if it is absent. */
function place(haystack: string, word: string): number | null {
  const at = nextOccurrence(haystack, word, 0)
  if (at !== -1) return (isWordStart(haystack, at) ? 300 : 150) - Math.min(at, 100)

  const acronym = initialsAt(haystack, word)
  if (acronym !== -1) return 60 - Math.min(acronym, 50)

  return null
}

/** The next place this word could match, preferring a word start over the first occurrence. */
function nextOccurrence(haystack: string, word: string, from: number): number {
  const first = haystack.indexOf(word, from)
  if (first === -1) return -1
  for (let index = first; index !== -1; index = haystack.indexOf(word, index + 1)) {
    if (isWordStart(haystack, index)) return index
  }
  return first
}

/** Where this word matches the initials of consecutive words (`nw` for "New worktree"), or -1. */
function initialsAt(haystack: string, word: string): number {
  if (word.length < 2) return -1
  const starts: number[] = []
  for (let index = 0; index < haystack.length; index += 1) {
    if (haystack[index] !== ' ' && isWordStart(haystack, index)) starts.push(index)
  }
  for (let from = 0; from + word.length <= starts.length; from += 1) {
    let all = true
    for (let step = 0; step < word.length; step += 1) {
      if (haystack[starts[from + step] as number] !== word[step]) {
        all = false
        break
      }
    }
    if (all) return starts[from] as number
  }
  return -1
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const before = text[index - 1] as string
  return before === ' ' || before === '/' || before === '-' || before === '_' || before === '.'
}

/** The list narrowed by the query; ties keep build order so the list does not reshuffle under the cursor. */
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

/**
 * The files to list, match quality first (`matchTier`) and recency breaking ties within a tier; with
 * nothing typed, the recent files. The runtime's answer may be for a shorter query and is narrowed here.
 */
export function rankFiles(found: readonly string[], recent: readonly string[], query: string, limit: number): string[] {
  const wanted = query.trim()
  if (wanted === '') return recent.slice(0, limit)
  const rows = [...new Set([...recent, ...found])]
    .map((path) => ({ path, points: fuzzyPathScore(path, wanted) }))
    .filter((row): row is { path: string; points: number } => row.points !== null)
    .map((row) => ({ ...row, tier: matchTier(row.path, wanted), seen: recent.indexOf(row.path) }))
  const age = (seen: number): number => (seen === -1 ? Infinity : seen)
  rows.sort((left, right) => right.tier - left.tier || age(left.seen) - age(right.seen) || right.points - left.points)
  return rows.slice(0, limit).map((row) => row.path)
}

/** A file row: the name to read, its directory beside it. */
export function fileItem(path: string): PaletteItem {
  const slash = path.lastIndexOf('/')
  return {
    kind: 'file',
    id: path,
    label: path.slice(slash + 1),
    hint: slash === -1 ? '' : path.slice(0, slash),
    detail: '',
    search: path
  }
}
