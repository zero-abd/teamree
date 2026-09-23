// What the palette offers, and how typing narrows it.
//
// Kept apart from the component because the interesting part is not the list,
// it is the ranking: with twenty worktrees open, a palette that matches the
// right thing third is a palette nobody uses twice.

import type { CliStatus, InstalledAgent, Project, UpdateState, Worktree } from '@shared/entities'
import { cliActionLabel } from '../dialogs/cliInstallModel'
import type { WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { MENU_ORDER, menuLabel } from '../menu/menuBar'
import { automaticUpdatesLabel } from '../updates/updateNotice'

/**
 * What a row can be asked to do: every command this window has, plus the few
 * things the palette offers that are not commands.
 *
 * The commands are not listed here. They used to be — a hand-written dozen that
 * had fallen six behind the menu bar, so Push, Commit, Close pane, Maximize
 * pane, both pane walks and both worktree walks were in every menu and in no
 * palette. Deriving the union from `WorkspaceCommand` is what makes that
 * impossible: a command added to the table is a row here without anybody
 * remembering to add one.
 */
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

  const actions: PaletteItem[] = [...commandActions(), ...ACTIONS, ...updateActions(context)].map((action) => {
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

/**
 * One row per command, in the order the menus read, called what the menu calls
 * it.
 *
 * The labels are not written here and must not be: the whole defect this
 * replaces was a palette keeping its own wording and its own list, so that
 * `Split pane right` in the menu was `Split right` in the palette and half the
 * menu was in the palette not at all. `menuLabel` is the one answer to what a
 * command is called, and `MENU_ORDER` the one answer to the order.
 */
function commandActions(): { id: PaletteAction; label: string; keywords: string }[] {
  return MENU_ORDER.map((command) => ({
    id: command,
    label: menuLabel(command),
    keywords: COMMAND_KEYWORDS[command]
  }))
}

/**
 * What somebody types looking for each command, beyond its own label.
 *
 * Total over the command union, for the reason `PLACEMENT` and `GROUP_OF` are:
 * a command added to the table with no thought about what a person would type
 * to find it stops the build here rather than shipping a row reachable only by
 * its exact name. Keywords matter more now than they did — the matcher requires
 * every typed word to actually appear — so a word left out is a word that finds
 * nothing.
 */
const COMMAND_KEYWORDS: Record<WorkspaceCommand, string> = {
  'new-worktree': 'new task create worktree branch start agent checkout',
  'new-terminal': 'new terminal shell pane open',
  'close-pane': 'close pane kill stop shut terminal',
  'find-in-pane': 'find search pane scrollback text',
  'split-right': 'split pane right vertical column',
  'split-down': 'split pane down horizontal row',
  'focus-previous-pane': 'focus previous pane back left',
  'focus-next-pane': 'focus next pane forward right',
  'expand-pane': 'maximize maximise expand pane full zoom',
  'previous-worktree': 'previous worktree up back',
  'next-worktree': 'next worktree down forward',
  'open-palette': 'go to worktree command palette search anything',
  'open-dashboard': 'all panes agents dashboard overview attention waiting failed working everywhere',
  'toggle-sidebar': 'toggle sidebar hide show projects',
  'toggle-right-panel': 'toggle right panel hide show files changes panes',
  // The page with everything about this machine on it. The keywords are what
  // people call the things that live there rather than what this app calls
  // them: somebody looking for the CLI link or the relay is not typing
  // "settings".
  'open-settings': 'settings preferences options config cli path relay start point font size updates editor',
  // Every word somebody might reach for the theme editor by, including both
  // spellings of the one word it is mostly about. Not "settings": there is a
  // page by that name now, and this is not it.
  'open-appearance': 'appearance theme colour color dark black contrast accent ground swatch',
  'commit-changes': 'commit changes diff git stage staged message files review',
  'push-worktree': 'push send remote origin upload publish branch ahead',
  'open-help': 'help shortcuts keys keyboard worktree cli docs how what'
}

/** The rows that are the palette's own, with no command and no menu item. */
const ACTIONS: readonly { id: PaletteAction; label: string; keywords: string }[] = [
  { id: 'toggle-changes', label: 'Show changes', keywords: 'diff git status files review changes' },
  { id: 'show-files', label: 'Show files', keywords: 'tree folder directory explorer browse open panel' },
  { id: 'add-project', label: 'Add project', keywords: 'add project repository repo folder clone' },
  {
    id: 'install-cli',
    // Replaced at build time by `cliActionLabel` when the link is the problem
    // rather than its absence. This is the wording for the ordinary case.
    label: 'Put teamree on my PATH',
    keywords: 'cli command line terminal install link symlink usr local bin path agent broken fix dangling'
  }
]

/**
 * Whether this row answers the query at all, and how well.
 *
 * The floor first, because the palette had none: every word typed has to be
 * *in* the row — as a run of characters, or as the initials of consecutive
 * words, which is how `nw` reaches "New worktree". Anything else returns null.
 * What it replaces accepted any subsequence of the typed letters scattered
 * anywhere at all, which is how `push` came back with "Stop checking for
 * updates automatically" (s-t-o-**p**… **u**pdates… **s**topping at whatever
 * letter came next) and `commit` with "Fix the broken teamree command". Those
 * are not near misses; they contain nothing of what was typed, and a palette
 * that answers with them is one nobody types into twice.
 *
 * Then the ranking, in the order a person would rank it: the whole query
 * appearing together beats the same words apart, a match that starts a word
 * beats one buried mid-word, an early match beats a late one, and an initialism
 * comes last — it is the loosest of the three ways in, so it settles ties among
 * rows that have already passed rather than admitting rows of its own.
 *
 * Returns null when any word of the query is not there.
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

  // The whole query as typed, in one piece. Worth more than any arrangement of
  // its words, and worth more again at the start of one.
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

/**
 * The next place this word could match, preferring one that starts a word.
 *
 * Taking the first occurrence outright is the obvious implementation and the
 * wrong one: "pane" against "Close pane" would match at the p of "pane" either
 * way, but "term" against "Show interminable output, new terminal" would score
 * the buried one and rank the row by it.
 */
function nextOccurrence(haystack: string, word: string, from: number): number {
  const first = haystack.indexOf(word, from)
  if (first === -1) return -1
  for (let index = first; index !== -1; index = haystack.indexOf(word, index + 1)) {
    if (isWordStart(haystack, index)) return index
  }
  return first
}

/**
 * Where this word matches the initials of consecutive words, or -1.
 *
 * An initialism is how a palette gets used once somebody knows it — `nw` for
 * "New worktree", `sr` for "Split pane right" — and it is the one loose match
 * worth keeping. Consecutive is what keeps it from being the old defect again:
 * letters may not skip a word to find the next one.
 */
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
