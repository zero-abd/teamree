// The settings page's judgements: whether this build can check for updates, where a project's relay
// comes from (an env var beating the file is the case nobody works out), and what the filter reads.

import type { AgentKind, CliStatus, InstalledAgent, RelaySetting, UpdateState } from '@shared/entities'
import { HARNESSES } from '../agents/harnesses'
import { cliPanel } from '../dialogs/cliInstallModel'
import { sinceLabel } from '../sidebar/agentRows'

export type UpdatePanel = {
  /** Which version this is, as a label; a non-release build says so here since it has no button. */
  headline: string
  /** Whether to show a check button: a non-release build has nothing published to compare with. */
  offersCheck: boolean
  /** When the last check was, in words. Null when none has ever run. */
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

  const lastChecked = update.checkedAt === null ? null : checkedLabel(update.checkedAt, now)

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
    problem: update.problem
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

/** The `teamree` command's section: one line of state and a button; the judgement is `cliInstallModel`'s. */
export type CliLine = {
  /** `/usr/local/bin/teamree → …`, or `Not installed`; a directory no readable PATH reaches is said here too. */
  state: string
  /** `Install` with no link, `Repair` for one leading elsewhere; null when this app can do nothing here. */
  action: 'Install' | 'Repair' | null
  /** The button's hover: what it does and whether macOS will ask for an admin password. */
  title: string | null
  /** What to type instead, when there is no button and typing would work. */
  manual: string | null
}

export function cliLine(status: CliStatus | null): CliLine {
  const none: CliLine = { state: 'Looking…', action: null, title: null, manual: null }
  if (status === null) return none
  const panel = cliPanel(status)
  if (!status.installable) return { ...none, state: `Not installable on ${status.platform}`, manual: panel.manual }
  if (status.source === null) return { ...none, state: 'No CLI in this build' }
  // A link into a mounted image or translocated copy dangles by the evening.
  if (status.impermanent !== null) {
    return { ...none, state: `Running from ${status.source} — move teamree to Applications` }
  }
  // An unbuilt CLI: the link would resolve and the command exit on its first line.
  if (status.bundle === null) return { ...none, state: 'Not built', manual: panel.manual }

  const reach = status.onPath === null ? ` · ${status.directory} not on PATH` : ''
  const title = panel.promise === null ? null : [panel.promise, panel.password].filter(Boolean).join(' · ')
  switch (status.state) {
    case 'linked':
      return { ...none, state: `${status.destination} → ${status.resolved ?? status.source}${reach}` }
    case 'elsewhere':
      return {
        state: `${status.destination} → ${status.resolved} (${status.dangling ? 'missing' : 'another copy'})${reach}`,
        action: 'Repair',
        title,
        manual: null
      }
    case 'file':
    case 'directory':
      return { ...none, state: `${status.destination} is a ${status.state} — move it aside` }
    default:
      return { state: `Not installed${reach}`, action: 'Install', title, manual: null }
  }
}

/** The page's sections in order. */
export const SETTINGS_SECTIONS = [
  { id: 'agents', label: 'Agents' },
  { id: 'projects', label: 'Projects' },
  { id: 'panes', label: 'Panes' },
  { id: 'notices', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'updates', label: 'Updates' },
  { id: 'cli', label: 'CLI' }
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

/** Case-insensitive, anywhere in the label; an empty filter keeps everything. */
export function labelMatches(label: string, query: string): boolean {
  const wanted = query.trim().toLowerCase()
  return wanted === '' || label.toLowerCase().includes(wanted)
}

/** What the filter reads in one row: its label, the option labels it offers and the value it holds. */
export type SettingsRow = { label: string; words: readonly string[] }

export function rowMatches(row: SettingsRow, query: string): boolean {
  return labelMatches(row.label, query) || row.words.some((word) => word !== '' && labelMatches(word, query))
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
