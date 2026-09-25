// What the palette offers, and how typing narrows and ranks it.

import {
  hasCheckout,
  type AgentKind,
  type CliStatus,
  type InstalledAgent,
  type Project,
  type RemovedWorktree,
  type UpdateState,
  type Worktree
} from '@shared/entities'
import { fuzzyPathScore, matchTier } from '@shared/fuzzyPath'
import { APPEARANCE_MODES, BUILT_IN_THEMES, type AppearanceMode } from '@shared/theme'
import { APPEARANCE_MODE_LABEL } from '../settings/AppearanceSettings'
import { harnessName } from '../agents/harnesses'
import { runName, siblingRuns } from '../compare/siblingRuns'
import type { WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { MENU_ORDER, menuLabel } from '../menu/menuBar'
import { agoLabel } from '../sidebar/agentRows'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { automaticUpdatesLabel } from '../updates/updateNotice'
import { landLabel, type LandOffer } from '../workspace/rightPanel/landOffer'

/** Every command this window has (derived from `WorkspaceCommand`, so none go missing) plus the palette's own rows. */
export type PaletteAction =
  | WorkspaceCommand
  | 'toggle-changes'
  | 'show-files'
  | 'open-branch'
  | 'open-pull-request'
  | 'install-cli'
  | 'check-for-updates'
  | 'toggle-automatic-updates'
  | WorktreeAction
  | 'discard-file'
  | 'unstage-file'
  | `appearance:${AppearanceMode}`
  /** A built-in theme by id. */
  | `theme:${string}`
  /** An Open in target by its label. */
  | `open-in:${string}`
  /** A compare with another run of the task on screen, by its worktree id. */
  | `compare:${string}`
  /** A removed worktree to check out again, by its `RemovedWorktree.id`. */
  | `restore:${string}`

/** What the sidebar row's menu does to the worktree on screen. */
type WorktreeAction =
  | 'rename-worktree'
  | 'reveal-worktree'
  | 'copy-worktree-path'
  | 'copy-worktree-branch'
  | 'update-worktree'
  | 'remove-worktree'
  | 'forget-worktree'
  | 'create-pull-request'
  | 'merge-into-base'
  | 'keep-run'

export type PaletteItem =
  /** Jump to a worktree; `agent` is a task run's, drawn as its glyph. */
  | { kind: 'worktree'; id: string; label: string; hint: string; detail: string; search: string; agent?: AgentKind }
  /** Run something; `unavailable` says why it would do nothing now (hidden unless it is all a query finds); `here` acts on the worktree on screen. */
  | {
      kind: 'action'
      id: PaletteAction
      label: string
      hint: string
      detail: string
      search: string
      unavailable?: string
      here?: true
    }
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
  /** Why a command would do nothing now, or null; absent reads as always available. */
  whyUnavailable?: (action: PaletteAction) => string | null
  /** The Open in targets for the worktree on screen, its project's editor first. */
  openIn?: readonly string[]
  /** The mode and preset on screen, which mark their own rows as current. */
  appearance?: { mode: AppearanceMode; themeId: string }
  /** The base's branch name when the worktree on screen is behind it and can update. */
  updateFrom?: string | null
  /** The focused file pane's entry in the Changes list, if it has one. */
  focusedChange?: { path: string; discardable: boolean; staged: boolean } | null
  /** What the worktree on screen can do with its finished branch; see `landOffer`. */
  land?: LandOffer | null
  /** Removed worktrees that can be restored, newest first. */
  removed?: readonly RemovedWorktree[]
  /** Which way the panel toggles read; absent reads as shown. */
  sidebarVisible?: boolean
  rightPanelOpen?: boolean
}

/**
 * Worktrees first (jumping is what the palette is for), the open one last among them, then what acts
 * on the worktree in front, then actions; a typed action name still sorts to the top.
 */
export function buildPaletteItems(context: PaletteContext): PaletteItem[] {
  const projectName = new Map(context.projects.map((project) => [project.id, project.name]))
  const open = (worktree: Worktree): boolean => worktree.id === context.activeWorktreeId

  const worktrees: PaletteItem[] = [
    ...context.worktrees.filter((worktree) => !open(worktree)),
    ...context.worktrees.filter(open)
  ].map((worktree) => {
    const project = projectName.get(worktree.projectId) ?? ''
    const display = worktreeDisplay(worktree)
    const label = display.title
    const agent = display.agent?.kind
    return {
      kind: 'worktree',
      id: worktree.id,
      label,
      ...(agent === undefined ? {} : { agent }),
      hint: display.branch ?? '',
      detail: [
        project,
        hasCheckout(worktree) ? '' : worktree.missing ? 'missing' : worktree.state,
        open(worktree) ? 'current' : ''
      ]
        .filter(Boolean)
        .join(' · '),
      // A branch name is often the only part a person remembers.
      search: `${worktreeLabel(display)} ${worktree.branch} ${project}`
    }
  })

  const rows: ActionRow[] = [
    ...commandActions(context),
    ...restoreActions(context),
    ...ACTIONS,
    ...updateActions(context),
    ...appearanceActions(context)
  ]
  const actions: PaletteItem[] = rows.map((action) => {
    const unavailable =
      action.unavailable ??
      (action.id === 'install-cli' && context.cli?.state === 'linked' ? 'installed' : null) ??
      ((action.id === 'open-branch' || action.id === 'open-pull-request') && context.projects.length === 0
        ? 'no project'
        : null) ??
      context.whyUnavailable?.(action.id) ??
      null
    return {
      kind: 'action',
      id: action.id,
      label: action.label,
      hint: action.hint ?? context.hintFor(action.id),
      detail: '',
      search: `${action.label} ${action.keywords}`,
      ...(unavailable === null ? {} : { unavailable })
    }
  })

  return [...worktrees, ...agentItems(context), ...worktreeActions(context), ...actions]
}

type ActionRow = { id: PaletteAction; label: string; keywords: string; hint?: string; unavailable?: string }

/** The sidebar row's menu for the worktree on screen, and the focused file's discard and unstage. */
function worktreeActions(context: PaletteContext): PaletteItem[] {
  const active = context.worktrees.find((worktree) => worktree.id === context.activeWorktreeId)
  if (active === undefined) return []
  const remove: ActionRow[] = [
    { id: 'forget-worktree', label: 'Remove Worktree from teamree', keywords: 'remove forget hide worktree sidebar' },
    { id: 'remove-worktree', label: 'Move Worktree to Trash…', keywords: 'remove delete worktree checkout trash' }
  ]
  const change = context.focusedChange
  const land = context.land ?? null
  const siblings = siblingRuns(active, context.worktrees)
  // As the row's menu: a checkout gone from disk has nothing to reveal, open or copy.
  const rows: ActionRow[] = active.missing
    ? remove
    : [
        { id: 'rename-worktree', label: 'Rename Worktree…', keywords: 'rename name title worktree' },
        { id: 'reveal-worktree', label: 'Reveal in Finder', keywords: 'reveal finder show folder directory checkout' },
        { id: 'copy-worktree-path', label: 'Copy Path', keywords: 'copy path clipboard worktree checkout directory' },
        { id: 'copy-worktree-branch', label: 'Copy Branch', keywords: 'copy branch name clipboard git' },
        // Reveal in Finder already is that row.
        ...(context.openIn ?? [])
          .filter((target) => target !== 'Finder')
          .map((target) => ({
            id: `open-in:${target}` as const,
            label: `Open in ${target}`,
            keywords: 'open in editor ide terminal finder external app'
          })),
        ...(land === null || land.kind === 'merged'
          ? []
          : [
              {
                id: land.kind === 'merge' ? ('merge-into-base' as const) : ('create-pull-request' as const),
                label: landLabel(land),
                keywords: 'land pull request pr merge review ship done github finish'
              }
            ]),
        ...siblings.map((other) => ({
          id: `compare:${other.id}` as const,
          label: `Compare with ${runName(other)}`,
          keywords: 'compare diff runs sibling agents task side by side'
        })),
        ...(context.updateFrom
          ? [
              {
                id: 'update-worktree' as const,
                label: `Update from ${context.updateFrom}`,
                keywords: 'update rebase merge pull behind base main sync'
              }
            ]
          : []),
        ...(siblings.length === 0
          ? []
          : [
              {
                id: 'keep-run' as const,
                label: 'Keep This Run…',
                keywords: 'keep winner pick choose run remove others'
              }
            ]),
        ...remove,
        ...(change?.discardable === true
          ? [
              {
                id: 'discard-file' as const,
                label: 'Discard File Changes…',
                keywords: 'discard revert restore undo throw away changes git',
                hint: change.path
              }
            ]
          : []),
        ...(change?.staged === true
          ? [
              {
                id: 'unstage-file' as const,
                label: 'Unstage File',
                keywords: 'unstage index staged git',
                hint: change.path
              }
            ]
          : [])
      ]
  return rows.map((row) => ({
    kind: 'action',
    id: row.id,
    label: row.label,
    hint: row.hint ?? '',
    detail: '',
    search: `${row.label} ${row.keywords}`,
    here: true
  }))
}

/** One row per removed worktree that can still come back, its age as the hint. */
function restoreActions(context: PaletteContext): ActionRow[] {
  const now = Date.now()
  return (context.removed ?? []).map((removed) => ({
    id: `restore:${removed.id}` as const,
    label: `Restore Worktree: ${worktreeLabel(worktreeDisplay(removed))}`,
    keywords: `restore undo removed deleted worktree bring back ${removed.branch}`,
    hint: agoLabel(now - removed.removedAt)
  }))
}

/** The three modes and every preset; the ones on screen cannot run. */
function appearanceActions(context: PaletteContext): ActionRow[] {
  const current = (on: boolean): { unavailable?: string } => (on ? { unavailable: 'current' } : {})
  return [
    ...APPEARANCE_MODES.map((mode) => ({
      id: `appearance:${mode}` as const,
      label: `Appearance: ${APPEARANCE_MODE_LABEL[mode]}`,
      keywords: 'mode theme tone os',
      ...current(context.appearance?.mode === mode)
    })),
    ...BUILT_IN_THEMES.map((theme) => ({
      id: `theme:${theme.id}` as const,
      label: `Theme: ${theme.name}`,
      keywords: 'appearance preset colour color',
      ...current(context.appearance?.themeId === theme.id)
    }))
  ]
}

/**
 * One row per agent the probe found, starting it in the ready worktree on screen; none until there is one.
 * Worded as "here" to keep it apart from "New Task", which makes another checkout.
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
    label: `Start ${harnessName(agent.kind)} Here`,
    hint: '',
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
      label: 'Check for Updates',
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
function commandActions(context: PaletteContext): { id: PaletteAction; label: string; keywords: string }[] {
  return MENU_ORDER.map((command) => ({
    id: command,
    label: menuLabel(command, context),
    keywords: COMMAND_KEYWORDS[command]
  }))
}

/** What somebody types looking for each command. Total over the union, so a new command fails the build here. */
const COMMAND_KEYWORDS: Record<WorkspaceCommand, string> = {
  'new-worktree': 'new task create worktree branch start agent checkout',
  'new-terminal': 'new terminal shell pane open',
  'new-markdown': 'new markdown notes page document write md file',
  'close-pane': 'close pane kill stop shut terminal',
  'reopen-closed-pane': 'reopen closed pane undo close resume agent session tab back',
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
  'next-needing': 'next needing you asking failed finished unread attention question answer',
  'previous-needing': 'previous needing you asking failed finished unread attention question answer back',
  'open-palette': 'go to worktree command palette search anything',
  'go-to-file': 'go to file open quick find path',
  'open-dashboard': 'all panes agents dashboard overview attention waiting failed working everywhere',
  'toggle-sidebar': 'toggle sidebar hide show projects',
  'toggle-right-panel': 'toggle right panel hide show files changes panes',
  'focus-sidebar': 'focus sidebar keyboard projects worktrees move',
  'focus-panes': 'focus panes terminal keyboard move back',
  'focus-right-panel': 'focus right panel keyboard files changes move',
  'focus-next-region': 'focus next region area part keyboard f6 cycle',
  'focus-previous-region': 'focus previous region area part keyboard f6 cycle back',
  // What people call the things on that page, not "settings".
  'open-settings': 'settings preferences options config cli path relay start point font size updates editor',
  // Both spellings; not "settings", which is the other page.
  'open-appearance': 'appearance theme colour color dark black contrast accent ground swatch',
  'add-project': 'add open project repository repo folder directory',
  'clone-repository': 'clone project repository repo git url remote github',
  'review-changes': 'review all changes diff viewed comment agent files',
  'commit-changes': 'commit changes diff git stage staged message files review',
  'push-worktree': 'push send remote origin upload publish branch ahead',
  'open-help': 'help shortcuts keys keyboard worktree cli docs how what',
  'bigger-text': 'bigger text font size zoom in larger increase terminal',
  'smaller-text': 'smaller text font size zoom out decrease terminal',
  'actual-size': 'actual size reset text font default zoom terminal'
}

/** The rows that are the palette's own, with no command and no menu item. */
const ACTIONS: readonly { id: PaletteAction; label: string; keywords: string }[] = [
  { id: 'toggle-changes', label: 'Show Changes', keywords: 'diff git status files review changes' },
  { id: 'show-files', label: 'Show Files', keywords: 'tree folder directory explorer browse open panel' },
  {
    id: 'open-branch',
    label: 'Open Branch…',
    keywords: 'checkout existing branch teammate remote worktree track take over'
  },
  { id: 'open-pull-request', label: 'Check Out Pull Request…', keywords: 'review pr github gh checkout teammate' },
  {
    id: 'install-cli',
    label: 'Install Command Line Tool',
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

const isDimmed = (item: PaletteItem): boolean => item.kind === 'action' && item.unavailable !== undefined

/**
 * The list narrowed by the query, what a row says before its hidden keywords; ties keep build order so
 * the list does not reshuffle under the cursor. What cannot run is left out unless it is all there is.
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const trimmed = query.trim()
  if (trimmed === '') return items.filter((item) => !isDimmed(item))

  const found = items
    .map((item, index) => {
      const shown = score(item.kind === 'worktree' ? `${item.label} ${item.hint}` : item.label, trimmed)
      return { item, index, shown: shown === null ? 0 : 1, points: shown ?? score(item.search, trimmed) }
    })
    .filter((row): row is { item: PaletteItem; index: number; shown: number; points: number } => row.points !== null)
    .sort(
      (left, right) =>
        right.shown - left.shown ||
        right.points - left.points ||
        left.item.label.length - right.item.label.length ||
        left.index - right.index
    )
    .map((row) => row.item)
  return found.every(isDimmed) ? found : found.filter((item) => !isDimmed(item))
}

/** What identifies a row across openings, for the Recent group. */
export const paletteKey = (item: PaletteItem): string => `${item.kind}:${item.id}`

/** The one column after a label: nothing for a dimmed row, a worktree's project and state, else the hint. */
export function trailing(item: PaletteItem): string {
  if (isDimmed(item)) return ''
  return item.kind === 'worktree' ? item.detail : item.hint
}

/** Rows under one header; a null title draws none. */
export type PaletteGroup = { title: string | null; items: PaletteItem[] }

/**
 * The list before anything is typed: Recent, Worktrees, the worktree on screen under `here`, then
 * Commands, each row once, none that would do nothing; empty groups left out.
 */
export function paletteGroups(items: readonly PaletteItem[], recent: readonly string[], here: string): PaletteGroup[] {
  const byKey = new Map(items.map((item) => [paletteKey(item), item]))
  const first = recent
    .map((key) => byKey.get(key))
    .filter((item): item is PaletteItem => item !== undefined && !isDimmed(item))
  const rest = filterPalette(
    items.filter((item) => !first.includes(item)),
    ''
  )
  const onScreen = (item: PaletteItem): boolean =>
    item.kind === 'agent' || (item.kind === 'action' && item.here === true)
  return [
    { title: 'Recent', items: first },
    { title: 'Worktrees', items: rest.filter((item) => item.kind === 'worktree') },
    { title: here, items: rest.filter(onScreen) },
    { title: 'Commands', items: rest.filter((item) => item.kind === 'action' && !onScreen(item)) }
  ].filter((group) => group.items.length > 0)
}

export const RECENT_KEPT = 5
const RECENT_KEY = 'teamree.palette.recent'

/** The list with `key` moved to the front, `RECENT_KEPT` at most. */
export function withRecent(recent: readonly string[], key: string): string[] {
  return [key, ...recent.filter((entry) => entry !== key)].slice(0, RECENT_KEPT)
}

export function readStoredRecent(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string').slice(0, RECENT_KEPT)
      : []
  } catch {
    return []
  }
}

export function writeStoredRecent(storage: Pick<Storage, 'setItem'> | undefined, recent: readonly string[]): void {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    // Storage full or blocked: Recent stays as it was.
  }
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
