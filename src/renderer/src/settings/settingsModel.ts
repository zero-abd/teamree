// The settings page's judgements: whether this build can check for updates, where a project's relay
// comes from (an env var beating the file is the case nobody works out), and what the filter reads.

import type { AddonStatus } from '@shared/contextProvider'
import type { AgentKind, CliStatus, InstalledAgent, PaneHostStatus, RelaySetting, UpdateState } from '@shared/entities'
import { HARNESSES } from '../agents/harnesses'
import type { IconName } from '../icons/Icon'
import { cliPanel, leavesLinkAlone } from '../dialogs/cliInstallModel'
import { sinceLabel } from '../sidebar/agentRows'
import { couldNotCheck } from '../updates/updateNotice'

export type UpdatePanel = {
  /** Which version this is, as a label; a non-release build says so here since it has no button. */
  headline: string
  /** Whether to show a check button: a non-release build has nothing published to compare with. */
  offersCheck: boolean
  /** When a check last got an answer, in words. Null when none has. */
  lastChecked: string | null
  /** Why the last check produced no answer, or null when it did. */
  problem: string | null
}

export function updatePanel(update: UpdateState | null, now: number): UpdatePanel {
  // Null is a window not yet told, not a build with no version.
  if (update === null) {
    return {
      headline: 'teamree (version unknown)',
      offersCheck: false,
      lastChecked: null,
      problem: null
    }
  }

  // An older runtime says only when it last tried; that counts when the try got an answer.
  const answeredAt =
    update.succeededAt !== undefined ? update.succeededAt : update.problem === null ? update.checkedAt : null
  const lastChecked = answeredAt === null ? null : checkedLabel(answeredAt, now)

  if (!update.checkable) {
    return {
      headline: `teamree ${update.current} (not a release)`,
      offersCheck: false,
      lastChecked,
      problem: update.problem
    }
  }

  return {
    headline: `teamree ${update.current}`,
    offersCheck: true,
    lastChecked,
    problem: update.problem === null ? null : couldNotCheck(update.problem)
  }
}

/** How long ago the last check was; under ten seconds `sinceLabel`'s "now" gets its own wording. */
function checkedLabel(checkedAt: number, now: number): string {
  const ago = sinceLabel(Math.max(0, now - checkedAt))
  return ago === 'now' ? 'Checked just now' : `Checked ${ago} ago`
}

export type RelayPanel = {
  /** What teamwork would dial, or `None`. */
  headline: string
  /** True when the headline is `None`, drawn as an empty value rather than a fact. */
  empty: boolean
  /** Where the URL came from. Null when there is none. */
  detail: string | null
  /** Said only when this process was started with the override set; Finder launches inherit no env. */
  override: string | null
}

export function relayPanel(relay: RelaySetting | undefined): RelayPanel {
  if (relay === undefined) return { headline: 'Reading…', empty: false, detail: null, override: null }

  const override = relay.override.value === null ? null : overrideLine(relay, relay.override.value)

  if (relay.url === null) {
    // No file is the ordinary state and needs no words; anything else is the runtime's reason.
    const problem = relay.problem === null || relay.problem === `no ${relay.file}` ? null : relay.problem
    return { headline: 'None', empty: true, detail: problem, override }
  }

  return {
    headline: relay.url,
    empty: false,
    detail: `From ${relay.source === 'environment' ? relay.override.name : relay.file}`,
    override
  }
}

/** The environment beating the file; only a relaunch after unsetting it changes that. */
function overrideLine(relay: RelaySetting, value: string): string {
  const { name } = relay.override
  return `${name}=${value} overrides ${relay.file} (${relay.onDisk.url ?? 'empty'}) until unset and relaunched`
}

/** The `teamree` command's section: a status row with its button, then a row per path. */
export type CliLine = {
  /** `Installed`, `Not installed`, `Link broken`…; ` · not on PATH` when no readable PATH reaches the link. */
  status: string
  /** The link and where it leads, or where this copy runs from; each drawn on its own row. */
  paths: { label: string; path: string }[]
  /** `Install` with no link, `Repair` for one leading elsewhere; null when this app can do nothing here. */
  action: 'Install' | 'Repair' | null
  /** The button's hover: what it does and whether macOS will ask for an admin password. */
  title: string | null
  /** What to type instead, when there is no button and typing would work. */
  manual: string | null
}

export function cliLine(status: CliStatus | null): CliLine {
  const none: CliLine = { status: 'Looking…', paths: [], action: null, title: null, manual: null }
  if (status === null) return none
  const panel = cliPanel(status)
  if (!status.installable) return { ...none, status: `Not installable on ${status.platform}`, manual: panel.manual }
  if (status.source === null) return { ...none, status: 'No CLI in this build' }
  // A link into a mounted image or translocated copy dangles by the evening.
  if (status.impermanent !== null) {
    return { ...none, status: 'Move teamree to Applications', paths: [{ label: 'Running from', path: status.source }] }
  }
  // An unbuilt CLI: the link would resolve and the command exit on its first line.
  if (status.bundle === null) return { ...none, status: 'Not built', manual: panel.manual }

  const offPath = status.onPath === null
  const reach = offPath ? ' · not on PATH' : ''
  const link = { label: 'Link', path: status.destination }
  const leads = (path: string): CliLine['paths'] => [link, { label: 'Target', path }]
  const title = panel.promise === null ? null : [panel.promise, panel.password].filter(Boolean).join(' · ')
  switch (status.state) {
    case 'linked':
      return { ...none, status: offPath ? 'Not on PATH' : 'Installed', paths: leads(status.resolved ?? status.source) }
    case 'elsewhere':
      return {
        status: `${status.dangling ? 'Link broken' : 'Another copy'}${reach}`,
        paths: status.resolved === null ? [link] : leads(status.resolved),
        action: leavesLinkAlone(status) ? null : 'Repair',
        title: leavesLinkAlone(status) ? null : title,
        manual: null
      }
    case 'file':
    case 'directory':
      return { ...none, status: `A ${status.state} is in the way`, paths: [link] }
    default:
      return { ...none, status: `Not installed${reach}`, action: 'Install', title }
  }
}

/** The page's sections in order, each under its group in the section list. */
export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', group: 'Workspace', icon: 'settings' },
  { id: 'agents', label: 'Agents', group: 'Workspace', icon: 'agent' },
  { id: 'projects', label: 'Projects', group: 'Workspace', icon: 'folder' },
  { id: 'git', label: 'Git', group: 'Workspace', icon: 'branch' },
  { id: 'panes', label: 'Panes', group: 'Workspace', icon: 'split-right' },
  { id: 'notices', label: 'Notifications', group: 'App', icon: 'bell' },
  { id: 'teamwork', label: 'Teamwork', group: 'App', icon: 'team' },
  { id: 'appearance', label: 'Appearance', group: 'App', icon: 'appearance' },
  { id: 'shortcuts', label: 'Shortcuts', group: 'App', icon: 'keyboard' },
  { id: 'addons', label: 'Add-ons', group: 'System', icon: 'plug' },
  { id: 'updates', label: 'Updates', group: 'System', icon: 'download' },
  { id: 'cli', label: 'CLI', group: 'System', icon: 'terminal' }
] as const satisfies readonly { id: string; label: string; group: string; icon: IconName }[]

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

/** Case-insensitive, anywhere in the label; an empty filter keeps everything. */
export function labelMatches(label: string, query: string): boolean {
  const wanted = query.trim().toLowerCase()
  return wanted === '' || label.toLowerCase().includes(wanted)
}

/** One setting as the filter and the palette find it; `about` is search text, never shown. */
export type SettingEntry = { section: SettingsSectionId; label: string; about: string }

const WORKTREES_IN = 'folder location directory path disk where new worktrees checkouts go'
const BRANCH_PREFIX = 'branch name naming prefix convention new task'

/** Every setting the page has, in page order; a project's rows are listed once under Projects. */
export const SETTINGS_CATALOG: readonly SettingEntry[] = [
  { section: 'general', label: 'Worktrees in', about: WORKTREES_IN },
  { section: 'general', label: 'Branch prefix', about: BRANCH_PREFIX },
  { section: 'general', label: 'Show in Menu Bar', about: 'status item tray quick note' },
  { section: 'general', label: 'Show Cost', about: 'tokens usage price dollars spend' },
  { section: 'general', label: 'Keep Awake', about: 'sleep power caffeinate lid battery' },
  { section: 'general', label: 'Default editor', about: 'open checkouts in ide app' },
  { section: 'general', label: 'Ask Before Deleting Worktrees', about: 'confirm remove delete prompt dialog' },
  { section: 'agents', label: 'Default agent', about: 'new task first harness' },
  { section: 'agents', label: 'Trust New Worktrees', about: 'trust folder prompt permission' },
  { section: 'agents', label: 'Warn Agents About Overlaps', about: 'overlap conflict same file hook' },
  { section: 'projects', label: 'Start new worktrees from', about: 'base ref start point main' },
  { section: 'projects', label: 'Fetch in Background', about: 'fetch remote origin timer focus' },
  { section: 'projects', label: 'Symlink into every new worktree', about: 'linked paths dependencies share' },
  { section: 'projects', label: 'Copy into every new worktree', about: 'copied paths secrets files' },
  { section: 'projects', label: 'Setup command', about: 'install bootstrap script' },
  { section: 'projects', label: 'Dev command', about: 'run dev server start watch' },
  { section: 'projects', label: 'Test command', about: 'run tests suite check' },
  { section: 'projects', label: 'Open checkouts in', about: 'editor ide app' },
  { section: 'projects', label: 'Relay', about: 'teamwork server url' },
  { section: 'projects', label: 'Worktrees in', about: WORKTREES_IN },
  { section: 'projects', label: 'Branch prefix', about: BRANCH_PREFIX },
  { section: 'git', label: 'Fetch every', about: 'fetch interval background remote origin minutes timer' },
  { section: 'git', label: 'Diff layout', about: 'side by side split inline unified review' },
  { section: 'git', label: 'Wrap Diff Lines', about: 'long lines wrapping review' },
  { section: 'git', label: 'Hide Whitespace Changes', about: 'ignore spaces indentation review' },
  { section: 'panes', label: 'Terminal text size', about: 'font size zoom' },
  { section: 'panes', label: 'Font', about: 'typeface family monospace' },
  { section: 'panes', label: 'Line height', about: 'spacing leading rows' },
  { section: 'panes', label: 'Cursor', about: 'caret blink bar block underline' },
  { section: 'panes', label: 'Option as Meta', about: 'alt key keyboard' },
  { section: 'panes', label: 'Copy on Select', about: 'clipboard selection' },
  { section: 'panes', label: 'Scrollback lines', about: 'history buffer' },
  { section: 'panes', label: 'Shell', about: 'zsh bash fish default program' },
  { section: 'panes', label: 'Ask Before Stopping Agents', about: 'confirm close pane kill prompt dialog' },
  {
    section: 'panes',
    label: 'Keep Agents Running When teamree Quits',
    about: 'experimental host background restart crash survive detach'
  },
  { section: 'notices', label: 'Notify', about: 'notification sound alert banner' },
  { section: 'notices', label: 'Agent Finishes', about: 'notification done stop idle exit' },
  { section: 'notices', label: 'Agent Asks', about: 'notification question waiting permission input' },
  { section: 'notices', label: 'Teammate Shares a Note', about: 'notification team teammates shared note' },
  { section: 'teamwork', label: 'Share Task Details', about: 'privacy presence teammates' },
  { section: 'appearance', label: 'Theme', about: 'colors colours dark light mode' },
  { section: 'appearance', label: 'Project Bar Buttons', about: 'sidebar new task plus menu icons hover always' },
  { section: 'shortcuts', label: 'Shortcuts', about: 'keyboard keys keybindings hotkeys chords' },
  { section: 'addons', label: 'Jac Graph Memory', about: 'jaseci graph history co-change why provenance uv plugin' },
  { section: 'updates', label: 'Check Automatically', about: 'update version release' },
  { section: 'cli', label: 'teamree command', about: 'cli terminal install link path shell' }
]

const ABOUT = new Map(SETTINGS_CATALOG.map((entry) => [entry.label, entry.about]))

/** What the filter reads in one row: its label, the option labels it offers and the value it holds. */
export type SettingsRow = { label: string; words: readonly string[] }

export function rowMatches(row: SettingsRow, query: string): boolean {
  return (
    labelMatches(row.label, query) ||
    row.words.some((word) => word !== '' && labelMatches(word, query)) ||
    describedOnly(row.label, query)
  )
}

/** True when only the setting's search text holds the query, so the page marks the whole label. */
export function describedOnly(label: string, query: string): boolean {
  const about = ABOUT.get(label)
  return query.trim() !== '' && about !== undefined && !labelMatches(label, query) && labelMatches(about, query)
}

/** The first setting, in page order, whose label or search text holds the query. */
export function firstMatch(query: string): SettingEntry | null {
  if (query.trim() === '') return null
  return SETTINGS_CATALOG.find((entry) => labelMatches(entry.label, query) || labelMatches(entry.about, query)) ?? null
}

/** The add-on's row: a state word, at most one button, and the on/off box once it is installed. */
export type AddonLine = {
  state: string
  action: 'install' | 'retry' | 'uv' | null
  /** Null until installed. */
  on: boolean | null
  problem: string | null
  /** The failed install's whole output, for Copy Details. */
  details: string | null
}

export function addonLine(status: AddonStatus | null, enabled: boolean): AddonLine {
  const line: AddonLine = { state: 'Reading…', action: null, on: null, problem: null, details: null }
  if (status === null) return line
  const installed = status.version !== undefined
  switch (status.state) {
    case 'installing':
      return { ...line, state: 'Installing…' }
    case 'failed':
      return {
        state: 'Failed',
        action: installed ? null : 'retry',
        on: installed ? enabled : null,
        problem: status.detail ?? null,
        details: status.output ?? null
      }
    case 'running':
      return {
        ...line,
        state: status.detail === 'starting' ? 'Starting…' : `Running ${status.version ?? ''}`.trim(),
        on: true
      }
    default:
      if (status.needs === 'uv') return { ...line, state: 'Needs uv', action: 'uv' }
      return installed ? { ...line, state: 'Off', on: enabled } : { ...line, state: 'Off', action: 'install' }
  }
}

/** Under Keep Agents Running: the panes that still end with the app, the shells that could move, and the host. */
export type PaneHostLines = { ending: string | null; move: string | null; host: string | null }

export function paneHostLines(status: PaneHostStatus | null, keeping: boolean): PaneHostLines {
  if (status === null) return { ending: null, move: null, host: null }
  const { inProcess, shells, panes } = status
  return {
    ending:
      keeping && inProcess > 0
        ? `${
            inProcess === 1 ? '1 open pane ends' : `${inProcess} open panes end`
          } when teamree quits; new panes keep running`
        : null,
    move: keeping && shells > 0 ? (shells === 1 ? 'Keep Shell Running' : `Keep ${shells} Shells Running`) : null,
    host: status.running ? `Host running · ${panes === 1 ? '1 pane' : `${panes} panes`}` : null
  }
}

/** An agent's row: `command` is null for one given arguments or chosen as default that the probe did not find. */
export type AgentRow = { kind: AgentKind; command: string | null }

export function agentRows(
  found: readonly InstalledAgent[],
  agentArgs: Readonly<Record<string, string>>,
  defaultAgent: string,
  probed: boolean
): AgentRow[] {
  const rows: AgentRow[] = found.map((agent) => ({ kind: agent.kind, command: agent.command }))
  if (!probed) return rows
  for (const kind of Object.keys(HARNESSES) as AgentKind[]) {
    const wanted = (agentArgs[kind] ?? '') !== '' || defaultAgent === kind
    if (wanted && !rows.some((row) => row.kind === kind)) rows.push({ kind, command: null })
  }
  return rows
}
