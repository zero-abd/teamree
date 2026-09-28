// What the palette offers, and how typing narrows and ranks it.

import {
  hasCheckout,
  type AgentKind,
  type CliStatus,
  type InstalledAgent,
  type Project,
  type ProjectBase,
  type RemovedWorktree,
  type RunKind,
  type Terminal,
  type UpdateState,
  type Worktree,
  type WorktreeStatus
} from '@shared/entities'
import { fuzzyPathScore, matchTier } from '@shared/fuzzyPath'
import { parseInvitation } from '@shared/invitation'
import type { SharedNoteSummary } from '@shared/sharedNote'
import { APPEARANCE_MODES, BUILT_IN_THEMES, type AppearanceMode } from '@shared/theme'
import { APPEARANCE_MODE_LABEL } from '../settings/AppearanceSettings'
import { SETTINGS_CATALOG, SETTINGS_SECTIONS } from '../settings/settingsModel'
import { canResumeConversations, harnessName } from '../agents/harnesses'
import { runName, siblingRuns } from '../compare/siblingRuns'
import type { WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import type { DiffOptions } from '../state/preferences'
import { MENU_ORDER, menuLabel, type PanelState } from '../menu/menuBar'
import {
  agentRows,
  agoLabel,
  dotTone,
  paneActivity,
  paneAgent,
  paneLabel,
  paneNamesById,
  sinceLabel,
  TONE_LABEL,
  worktreeTone,
  type DotTone
} from '../sidebar/agentRows'
import { baseFreshness } from '../sidebar/baseFreshness'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { automaticUpdatesLabel } from '../updates/updateNotice'
import { landLabel, landNote, type LandOffer } from '../workspace/rightPanel/landOffer'
import type { RunOffer } from '../workspace/runButtons'
import { RUN_LABEL } from '@shared/runCommands'
import type { RightPanelTab } from '../workspace/rightPanel/rightPanelState'

/** Every command this window has (derived from `WorkspaceCommand`, so none go missing) plus the palette's own rows. */
export type PaletteAction =
  | WorkspaceCommand
  | 'toggle-changes'
  | 'show-files'
  | 'open-branch'
  | 'open-pull-request'
  | 'new-task-from-issue'
  | 'install-cli'
  | 'show-ports'
  | 'search-contents'
  | 'show-decisions'
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
  /** Clean Up Merged… for a project, by its id. */
  | `clean-up:${string}`
  /** Push main for a project, by its id. */
  | `push-base:${string}`
  /** Fetch Now for a project, by its id. */
  | `fetch:${string}`
  /** A project's Teamwork page, by its id. */
  | `teamwork:${string}`
  /** A note a teammate shared, by its share id. */
  | `shared-note:${string}`
  /** A query that found nothing to run: New Task with it as the task, Open Branch narrowed to it. */
  | `new-task:${string}`
  | `open-branch:${string}`
  /** A pasted invitation, by the text pasted. */
  | `join:${string}`
  /** Run Dev or Run Tests in the worktree on screen, restarted, or stopped. */
  | `run:${RunKind}`
  | `restart-run:${RunKind}`
  | `stop-run:${RunKind}`
  /** Settings, opened at one setting by its label. */
  | `setting:${string}`

/** What the sidebar row's menu does to the worktree on screen. */
type WorktreeAction =
  | 'resume-conversation'
  | 'rename-worktree'
  | 'reveal-worktree'
  | 'copy-worktree-path'
  | 'copy-worktree-branch'
  | 'update-worktree'
  | 'resolve-conflicts'
  | 'continue-update'
  | 'abort-update'
  | 'remove-worktree'
  | 'forget-worktree'
  | 'create-pull-request'
  | 'merge-into-base'
  | 'keep-run'

export type PaletteItem =
  /** Jump to a worktree; `agent` is a task run's, drawn as its glyph; `tone` is the sidebar row's dot. */
  | {
      kind: 'worktree'
      id: string
      label: string
      hint: string
      detail: string
      search: string
      agent?: AgentKind
      tone?: DotTone
      /** When it was last on screen, and how long ago, for one visited before and not on screen now. */
      visitedAt?: number
      age?: string
    }
  /** Go to an agent or command pane of any worktree; `id` is the terminal, `activeAt` its last output or look. */
  | {
      kind: 'pane'
      id: string
      worktreeId: string
      label: string
      hint: string
      detail: string
      search: string
      agent?: AgentKind
      tone: DotTone
      activeAt: number
      age?: string
    }
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
  /** What git last said about each worktree; Push reads Publish Branch on one that tracks nothing. */
  statuses?: PanelState['statuses']
  /** Removed worktrees that can be restored, newest first. */
  removed?: readonly RemovedWorktree[]
  /** Projects with a merged worktree; absent reads as every project. */
  merged?: ReadonlySet<string>
  /** Bases ahead of their upstream. */
  unpushed?: readonly ProjectBase[]
  /** Which way the panel toggles read; absent reads as shown. */
  sidebarVisible?: boolean
  rightPanelOpen?: boolean
  diffOptions?: DiffOptions
  /** The focused markdown pane shows its source. */
  markdownSource?: boolean
  rightPanelTab?: RightPanelTab
  /** Every pane, for each worktree row's dot. */
  terminals?: readonly Terminal[]
  /** Whether the worktree on screen has a past conversation to resume; absent reads as none. */
  resumable?: boolean
  /** The run commands of the worktree on screen, each with its pane. */
  runs?: readonly RunOffer[]
  /** Received notes as the lists show them, deleted ones left out. */
  sharedNotes?: readonly SharedNoteSummary[]
  /** When each worktree was last on screen, by id; see `visitHistory.ts`. */
  visited?: Readonly<Record<string, number>>
  /** When each pane was last looked at, by terminal id. */
  paneSeenAt?: Readonly<Record<string, number>>
  /** The pane in front, left out of Panes. */
  focusedPaneId?: string | null
  /** The clock the ages are read against; absent, no ages. */
  now?: number
}

/**
 * Worktrees first (jumping is what the palette is for), the open one last among them, then what acts
 * on the worktree in front, then actions; a typed action name still sorts to the top.
 */
export function buildPaletteItems(context: PaletteContext): PaletteItem[] {
  const projectName = new Map(context.projects.map((project) => [project.id, project.name]))
  const open = (worktree: Worktree): boolean => worktree.id === context.activeWorktreeId
  const terminals = context.terminals ?? []

  const worktrees: PaletteItem[] = [
    ...context.worktrees.filter((worktree) => !open(worktree)),
    ...context.worktrees.filter(open)
  ].map((worktree) => {
    const project = projectName.get(worktree.projectId) ?? ''
    const display = worktreeDisplay(worktree)
    const label = display.title
    const agent = display.agent?.kind
    // The clock only feeds `quietFor`, which no tone reads.
    const tone = hasCheckout(worktree) ? worktreeTone(agentRows(terminals, worktree, 0)) : null
    const visitedAt = open(worktree) ? undefined : context.visited?.[worktree.id]
    return {
      kind: 'worktree',
      id: worktree.id,
      label,
      ...(agent === undefined ? {} : { agent }),
      ...(tone === null ? {} : { tone }),
      ...(visitedAt === undefined ? {} : { visitedAt, ...ageOf(visitedAt, context.now) }),
      hint: display.branch ?? '',
      detail: [
        project,
        hasCheckout(worktree) ? '' : worktree.missing ? 'missing' : worktree.state,
        tone !== null && SAID_TONES.has(tone) ? TONE_LABEL[tone] : '',
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
    ...cleanUpActions(context),
    ...pushBaseActions(context),
    ...fetchActions(context),
    ...teamworkActions(context),
    ...panelActions(context),
    ...ACTIONS,
    ...updateActions(context),
    ...appearanceActions(context),
    ...settingActions()
  ]
  const actions: PaletteItem[] = rows.map((action) => {
    const unavailable =
      action.unavailable ??
      (action.id === 'install-cli' && context.cli?.state === 'linked' ? 'installed' : null) ??
      ((action.id === 'open-branch' ||
        action.id === 'open-pull-request' ||
        action.id === 'new-task-from-issue' ||
        action.id === 'show-decisions') &&
      context.projects.length === 0
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

  return [...worktrees, ...paneItems(context), ...agentItems(context), ...worktreeActions(context), ...actions]
}

function ageOf(at: number, now: number | undefined): { age?: string } {
  return now === undefined ? {} : { age: sinceLabel(Math.max(0, now - at)) }
}

/** An agent, a named pane or a program other than the shell: plain prompts are left to the sidebar. */
function isWorthListing(terminal: Terminal): boolean {
  return (
    paneAgent(terminal) !== undefined ||
    (terminal.label?.trim() ?? '') !== '' ||
    paneLabel(terminal) !== paneLabel({ title: '', shell: terminal.shell })
  )
}

/** Every worktree's agent and command panes, the latest active first, as `Claude Code · pagination`. */
function paneItems(context: PaletteContext): PaletteItem[] {
  const projectName = new Map(context.projects.map((project) => [project.id, project.name]))
  const terminals = context.terminals ?? []
  return context.worktrees
    .flatMap((worktree) => {
      const mine = terminals.filter((terminal) => terminal.worktreeId === worktree.id)
      const names = paneNamesById(mine)
      const where = worktreeLabel(worktreeDisplay(worktree))
      const project = projectName.get(worktree.projectId) ?? ''
      return mine
        .filter((terminal) => terminal.id !== context.focusedPaneId && isWorthListing(terminal))
        .map((terminal): PaletteItem => {
          const name = names[terminal.id] ?? paneLabel(terminal)
          const agent = paneAgent(terminal)
          const activeAt = Math.max(terminal.lastOutputAt, context.paneSeenAt?.[terminal.id] ?? 0)
          return {
            kind: 'pane',
            id: terminal.id,
            worktreeId: worktree.id,
            label: name === where ? name : `${name} · ${where}`,
            hint: '',
            detail: project,
            search: `${name} ${where} ${terminal.title} ${agent === undefined ? '' : harnessName(agent)} ${project}`,
            ...(agent === undefined ? {} : { agent }),
            tone: dotTone(paneActivity(terminal, worktree.report), agent),
            activeAt,
            ...ageOf(activeAt, context.now)
          }
        })
    })
    .sort((left, right) => (right.kind === 'pane' ? right.activeAt : 0) - (left.kind === 'pane' ? left.activeAt : 0))
}

type ActionRow = { id: PaletteAction; label: string; keywords: string; hint?: string; unavailable?: string }

/** The tones a worktree row names in words; the dot alone says the rest. */
const SAID_TONES: ReadonlySet<DotTone> = new Set(['failed', 'waiting', 'working'])

/** The right panel's two tabs, worded for what choosing them does now. */
function panelActions(context: PaletteContext): ActionRow[] {
  const showing = (tab: RightPanelTab): boolean => context.rightPanelOpen !== false && context.rightPanelTab === tab
  return [
    {
      id: 'toggle-changes',
      label: showing('changes') ? 'Hide Changes' : 'Show Changes',
      keywords: 'diff git status files review changes'
    },
    {
      id: 'show-files',
      label: 'Show Files',
      keywords: 'tree folder directory explorer browse open panel',
      ...(showing('files') ? { unavailable: 'shown' } : {})
    }
  ]
}

/** An update stopped part-way: the conflicts, and the two ways out of it. */
function midUpdateRows(status: Pick<Partial<WorktreeStatus>, 'operation' | 'conflicted'> | undefined): ActionRow[] {
  if (status?.operation === undefined) return []
  return [
    { id: 'resolve-conflicts', label: 'Resolve Conflicts', keywords: 'conflicts merge rebase resolve markers' },
    {
      id: 'continue-update',
      label: 'Continue Update',
      keywords: 'continue finish merge rebase conflicts resolved',
      ...((status.conflicted ?? 0) > 0 ? { unavailable: `${status.conflicted} conflicted` } : {})
    },
    { id: 'abort-update', label: 'Abort Update', keywords: 'abort undo cancel merge rebase conflicts' }
  ]
}

/** The sidebar row's menu for the worktree on screen, and the focused file's discard and unstage. */
function worktreeActions(context: PaletteContext): PaletteItem[] {
  const active = context.worktrees.find((worktree) => worktree.id === context.activeWorktreeId)
  if (active === undefined) return []
  const remove: ActionRow[] = [
    { id: 'forget-worktree', label: 'Remove Worktree from teamree', keywords: 'remove forget hide worktree sidebar' },
    { id: 'remove-worktree', label: 'Delete Worktree…', keywords: 'remove delete worktree checkout trash' }
  ]
  const change = context.focusedChange
  const land = context.land ?? null
  const siblings = siblingRuns(active, context.worktrees)
  // As the row's menu: a checkout gone from disk has nothing to reveal, open or copy.
  const rows: ActionRow[] = active.missing
    ? remove
    : [
        ...(canResumeConversations(context.agents)
          ? [
              {
                id: 'resume-conversation' as const,
                label: 'Resume Conversation…',
                keywords: 'resume conversation session history past agent continue',
                ...(context.resumable === true ? {} : { unavailable: 'no past conversations' })
              }
            ]
          : []),
        ...runRows(context.runs ?? []),
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
        ...(land === null || land.kind === 'merged' ? [] : [landRow(land)]),
        ...siblings.map((other) => ({
          id: `compare:${other.id}` as const,
          label: `Compare with ${runName(other)}`,
          keywords: 'compare diff runs sibling agents task side by side'
        })),
        ...midUpdateRows(context.statuses?.[active.id]),
        ...(context.updateFrom
          ? [
              {
                id: 'update-worktree' as const,
                label: `Update from ${context.updateFrom}`,
                keywords: 'update rebase merge pull behind base main sync parent'
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
    here: true,
    ...(row.unavailable === undefined ? {} : { unavailable: row.unavailable })
  }))
}

/** `Run: Dev` with its command as the hint, or Show, Restart and Stop while its pane runs. */
function runRows(runs: readonly RunOffer[]): ActionRow[] {
  const keywords = 'run start dev server test tests script npm serve watch'
  return runs.flatMap((run): ActionRow[] => {
    const label = RUN_LABEL[run.kind]
    if (run.state !== 'running') {
      return [{ id: `run:${run.kind}`, label: `Run: ${label}`, keywords, hint: run.command }]
    }
    return [
      { id: `run:${run.kind}`, label: `Show ${label}`, keywords, hint: run.command },
      { id: `restart-run:${run.kind}`, label: `Restart ${label}`, keywords: `${keywords} restart again` },
      { id: `stop-run:${run.kind}`, label: `Stop ${label}`, keywords: `${keywords} stop kill interrupt` }
    ]
  })
}

/** The header's land: dimmed with why while blocked, and one that commits first counts what it commits. */
function landRow(land: Exclude<LandOffer, { kind: 'merged' }>): ActionRow {
  const note = landNote(land)
  const commitsFirst = land.kind !== 'open-pr' && land.uncommitted !== undefined
  return {
    id: land.kind === 'merge' ? 'merge-into-base' : 'create-pull-request',
    label: landLabel(land),
    keywords: 'land pull request pr merge review ship done github finish parent',
    ...(note === undefined ? {} : commitsFirst ? { hint: note } : { unavailable: note })
  }
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

/** Clean Up Merged… per project, its name as the hint. */
function cleanUpActions(context: PaletteContext): ActionRow[] {
  return context.projects.map((project) => ({
    id: `clean-up:${project.id}` as const,
    label: 'Clean Up Merged…',
    keywords: 'clean up remove delete merged landed finished worktrees prune tidy',
    hint: project.name,
    ...(context.merged === undefined || context.merged.has(project.id) ? {} : { unavailable: 'nothing merged' })
  }))
}

/** Push main per project whose main is ahead, its name and count as the hint. */
function pushBaseActions(context: PaletteContext): ActionRow[] {
  return (context.unpushed ?? []).flatMap((base) => {
    const project = context.projects.find((entry) => entry.id === base.projectId)
    if (project === undefined) return []
    return [
      {
        id: `push-base:${project.id}` as const,
        label: `Push ${base.branch}`,
        keywords: 'push main base origin landed unpushed upload',
        hint: `${project.name} · ↑${base.ahead}`
      }
    ]
  })
}

/** Fetch Now per project, its name and how old its base is as the hint. */
function fetchActions(context: PaletteContext): ActionRow[] {
  const now = Date.now()
  return context.projects.map((project) => ({
    id: `fetch:${project.id}` as const,
    label: 'Fetch Now',
    keywords: `fetch origin remote refresh sync pull base ${project.baseRef} ${project.name}`,
    hint: `${project.name} · ${baseFreshness(project, now) ?? project.baseRef}`
  }))
}

/** One row per setting label, hinted with the section it is first found in. */
function settingActions(): ActionRow[] {
  const seen = new Set<string>()
  return SETTINGS_CATALOG.filter((entry) => !seen.has(entry.label) && seen.add(entry.label)).map((entry) => {
    const section = SETTINGS_SECTIONS.find((each) => each.id === entry.section)?.label ?? ''
    return {
      id: `setting:${entry.label}` as const,
      label: `Open Setting: ${entry.label}`,
      keywords: `settings preferences ${section} ${entry.about}`,
      hint: section
    }
  })
}

const isSetting = (item: PaletteItem): boolean => item.kind === 'action' && item.id.startsWith('setting:')

/** A Teamwork row per project, named with its unread notes in the hint, then each shared note newest first. */
function teamworkActions(context: PaletteContext): ActionRow[] {
  const now = Date.now()
  const notes = [...(context.sharedNotes ?? [])].sort((a, b) => b.receivedAt - a.receivedAt)
  const projectName = new Map(context.projects.map((project) => [project.id, project.name]))
  return [
    ...context.projects.map((project) => {
      const unread = notes.filter((note) => note.projectId === project.id && note.read !== true).length
      return {
        id: `teamwork:${project.id}` as const,
        label: 'Teamwork',
        keywords: `${project.name} team teammates relay invite join share notes`,
        hint: unread > 0 ? `${project.name} · ${unread} unread` : project.name
      }
    }),
    ...notes.map((note) => ({
      id: `shared-note:${note.shareId}` as const,
      label: `Shared Note: ${note.title}`,
      keywords: `teammate received ${note.handle} ${projectName.get(note.projectId) ?? ''}`,
      hint: [note.handle, agoLabel(now - note.receivedAt), note.read === true ? '' : 'unread']
        .filter(Boolean)
        .join(' · ')
    }))
  ]
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
  'new-child-task': 'new child task sub subtask under parent split fan out worktree',
  'new-terminal': 'new terminal shell pane open',
  'new-markdown': 'new markdown notes page document write md file',
  'close-pane': 'close pane kill stop shut terminal',
  'reopen-closed-pane': 'reopen closed pane undo close resume agent session tab back',
  'save-file': 'save file write disk edits',
  'save-all': 'save all files write disk edits',
  'find-in-pane': 'find search pane scrollback text',
  'clear-pane': 'clear pane terminal screen scrollback reset cls',
  'split-right': 'split pane right vertical column',
  'split-down': 'split pane down horizontal row',
  'focus-previous-pane': 'focus previous pane back left',
  'focus-next-pane': 'focus next pane forward right',
  'select-next-pane': 'select next pane tab switch cycle',
  'select-previous-pane': 'select previous pane tab switch cycle back',
  'next-file-tab': 'next file tab column page switch group',
  'previous-file-tab': 'previous file tab column page switch back group',
  'move-tab-next': 'move tab next pane group right',
  'move-tab-previous': 'move tab previous pane group left',
  'split-tab-right': 'split tab right new pane group move out',
  'split-tab-down': 'split tab down new pane group move out below',
  'expand-pane': 'maximize maximise expand pane full zoom',
  'previous-worktree': 'previous worktree up back',
  'next-worktree': 'next worktree down forward',
  'worktree-back': 'back previous last recent history return toggle worktree where was',
  'worktree-forward': 'forward next history worktree redo',
  'quick-note': 'quick note jot remember follow up todo write menu bar',
  'next-needing': 'next needing you asking failed finished unread attention question answer',
  'previous-needing': 'previous needing you asking failed finished unread attention question answer back',
  'open-palette': 'go to worktree command palette search anything',
  'go-to-file': 'go to file open quick find path',
  'go-to-line': 'go to line number jump row column',
  'search-in-files': 'search find in files contents text grep across tasks worktrees usages references',
  'open-dashboard': 'all panes agents dashboard overview attention waiting failed working everywhere',
  'toggle-sidebar': 'toggle sidebar hide show projects',
  'toggle-right-panel': 'toggle right panel hide show files changes panes',
  'focus-sidebar': 'focus sidebar keyboard projects worktrees move',
  'filter-sidebar': 'filter sidebar worktrees tasks branch issue compact hide done working changed mine',
  'focus-panes': 'focus panes terminal keyboard move back',
  'focus-right-panel': 'focus right panel keyboard files changes move',
  'focus-next-region': 'focus next region area part keyboard f6 cycle',
  'focus-previous-region': 'focus previous region area part keyboard f6 cycle back',
  // What people call the things on that page, not "settings".
  'open-settings': 'settings preferences options config cli path relay start point font size updates editor',
  // Both spellings; not "settings", which is the other page.
  'open-appearance': 'appearance theme colour color dark black contrast accent ground swatch',
  'toggle-diff-wrap': 'wrap unwrap diff lines long soft word patch review',
  'toggle-diff-whitespace': 'whitespace ignore hide show spaces indent diff patch review -w',
  'toggle-markdown-source': 'markdown source raw text page front matter yaml md view',
  'add-project': 'add open project repository repo folder directory',
  'clone-repository': 'clone project repository repo git url remote github',
  'join-team': 'join team invitation invite link paste teammate accept teamwork',
  'review-changes': 'review all changes diff viewed comment agent files branch base whole task',
  'commit-changes': 'commit changes diff git stage staged message files review',
  'push-worktree': 'push send remote origin upload publish branch ahead',
  'open-help': 'help shortcuts keys keyboard worktree cli docs how what',
  'open-setup': 'setup welcome first run onboarding agents default notifications test cli path',
  'bigger-text': 'bigger text font size zoom in larger increase terminal',
  'smaller-text': 'smaller text font size zoom out decrease terminal',
  'actual-size': 'actual size reset text font default zoom terminal'
}

/** The rows that are the palette's own, with no command and no menu item. */
const ACTIONS: readonly { id: PaletteAction; label: string; keywords: string }[] = [
  {
    id: 'open-branch',
    label: 'Open Branch…',
    keywords: 'checkout existing branch teammate remote worktree track take over'
  },
  { id: 'open-pull-request', label: 'Check Out Pull Request…', keywords: 'review pr github gh checkout teammate' },
  { id: 'new-task-from-issue', label: 'New Task from Issue…', keywords: 'github gh issue ticket bug start task' },
  {
    id: 'show-decisions',
    label: 'Show Decisions',
    keywords: 'decisions claims notes questions context ledger memory agents overlap resolve'
  },
  {
    id: 'install-cli',
    label: 'Install Command Line Tool',
    keywords: 'cli command line terminal install link symlink usr local bin path agent broken fix dangling'
  },
  { id: 'show-ports', label: 'Show Ports', keywords: 'ports listening server dev localhost browser url http stop' }
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
const isHere = (item: PaletteItem): boolean => item.kind === 'action' && item.here === true

/**
 * The list narrowed by the query, what a row says before its hidden keywords; ties go to the worktree
 * on screen, then keep build order so the list does not reshuffle under the cursor. What cannot run is
 * left out unless it is all there is, or it is the worktree's own and named by the query, and then it goes last.
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
        Number(isDimmed(left.item)) - Number(isDimmed(right.item)) ||
        Number(isSetting(left.item)) - Number(isSetting(right.item)) ||
        right.shown - left.shown ||
        right.points - left.points ||
        Number(isHere(right.item)) - Number(isHere(left.item)) ||
        left.item.label.length - right.item.label.length ||
        left.index - right.index
    )
  if (found.every((row) => isDimmed(row.item))) return found.map((row) => row.item)
  const named = (row: (typeof found)[number]): boolean => row.shown === 1 && isHere(row.item)
  return found.filter((row) => !isDimmed(row.item) || named(row)).map((row) => row.item)
}

/**
 * A typed query as ranked rows under a header per kind, the kind of the best match first and files after, a
 * pasted invitation's Join first. When nothing in it would run, it ends on New Task and Open Branch from the
 * query; `files` is null while the runtime is still asked.
 */
export function queryGroups(
  items: readonly PaletteItem[],
  query: string,
  files: readonly PaletteItem[] | null
): PaletteGroup[] {
  const join = joinFrom(query.trim())
  const found = filterPalette(items, query)
  const stuck = join === null && files !== null && files.length === 0 && found.every(isDimmed)
  const listed = stuck ? [...found, ...startFrom(items, query.trim())] : found
  const ranked = join === null ? listed : [join, ...listed.filter((item) => !isDimmed(item))]
  const byKind = new Map<string, PaletteItem[]>()
  for (const item of [...ranked, ...(files ?? [])]) {
    const title = KIND_TITLE[item.kind]
    byKind.set(title, [...(byKind.get(title) ?? []), item])
  }
  return [...byKind].map(([title, rows]) => ({ title, items: rows }))
}

const KIND_TITLE: Record<PaletteItem['kind'], string> = {
  worktree: 'Worktrees',
  pane: 'Panes',
  file: 'Files',
  action: 'Commands',
  agent: 'Commands'
}

/** Join <project> from <sender> for a query holding an invitation link, else null. */
function joinFrom(query: string): PaletteItem | null {
  const parsed = parseInvitation(query)
  if (!parsed.ok) return null
  const label = `Join ${parsed.invitation.project} from ${parsed.invitation.from}`
  return { kind: 'action', id: `join:${query}`, label, hint: '', detail: '', search: label }
}

/** New Task and Open Branch with the query carried in, each only where its own row would run. */
function startFrom(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const runs = (id: PaletteAction): PaletteItem | undefined =>
    items.find((item) => item.kind === 'action' && item.id === id && item.unavailable === undefined)
  const task = runs('new-worktree')
  const branch = runs('open-branch')
  const row = (id: PaletteAction, label: string, hint: string): PaletteItem => ({
    kind: 'action',
    id,
    label,
    hint,
    detail: '',
    search: label
  })
  return [
    ...(task === undefined ? [] : [row(`new-task:${query}`, `New Task: “${query}”`, task.hint)]),
    ...(branch === undefined ? [] : [row(`open-branch:${query}`, `Open Branch: “${query}”`, '')])
  ]
}

/** What identifies a row across openings, for the Recent group. */
export const paletteKey = (item: PaletteItem): string => `${item.kind}:${item.id}`

/** The one column after a label: nothing for a dimmed row, a worktree's project and state, else the hint. */
export function trailing(item: PaletteItem): string {
  if (isDimmed(item)) return ''
  return item.kind === 'worktree' || item.kind === 'pane' ? item.detail : item.hint
}

/** Rows under one header; a null title draws none. */
export type PaletteGroup = { title: string | null; items: PaletteItem[] }

/** How many panes the first screen lists; typing finds the rest. */
export const PANES_SHOWN = 6

/**
 * The list before anything is typed: the worktrees last visited, the panes last active, the other worktrees,
 * the worktree on screen under `here`, then Commands led by `recent`; each row once, none that would do nothing, no setting.
 */
export function paletteGroups(items: readonly PaletteItem[], recent: readonly string[], here: string): PaletteGroup[] {
  const byKey = new Map(items.map((item) => [paletteKey(item), item]))
  const visited = items
    .filter((item) => item.kind === 'worktree' && item.visitedAt !== undefined)
    .sort((left, right) => visitedAt(right) - visitedAt(left))
    .slice(0, RECENT_KEPT)
  const panes = items.filter((item) => item.kind === 'pane').slice(0, PANES_SHOWN)
  const commands = recent
    .map((key) => byKey.get(key))
    .filter((item): item is PaletteItem => item !== undefined && !isDimmed(item))
  const rest = filterPalette(
    items.filter((item) => !visited.includes(item) && !commands.includes(item) && !isSetting(item)),
    ''
  )
  const onScreen = (item: PaletteItem): boolean =>
    item.kind === 'agent' || (item.kind === 'action' && item.here === true)
  return [
    { title: 'Recent', items: visited },
    { title: 'Panes', items: panes },
    { title: 'Worktrees', items: rest.filter((item) => item.kind === 'worktree') },
    { title: here, items: rest.filter(onScreen) },
    { title: 'Commands', items: [...commands, ...rest.filter((item) => item.kind === 'action' && !onScreen(item))] }
  ].filter((group) => group.items.length > 0)
}

const visitedAt = (item: PaletteItem): number => (item.kind === 'worktree' ? (item.visitedAt ?? 0) : 0)

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

/** The row that hands what is typed to the Search tab. */
export function searchContentsItem(query: string): PaletteItem {
  return {
    kind: 'action',
    id: 'search-contents',
    label: `Search in Files: “${query}”`,
    hint: '',
    detail: '',
    search: query
  }
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
