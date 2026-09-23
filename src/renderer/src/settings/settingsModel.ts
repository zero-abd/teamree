// The settings page's two non-trivial sentences: whether this build can check for updates, and
// where a project's relay comes from (an env var beating the file is the case nobody works out).

import type { CliStatus, RelaySetting, UpdateState } from '@shared/entities'
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

  // A check asks GitHub for the newest release and opens the disk image; teamree installs nothing itself.
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
  /** What teamwork would dial, in one line. */
  headline: string
  /** Where that came from, or why there is nothing. Null while it is unknown. */
  detail: string | null
  /** Said only when this process was started with the override set; Finder launches inherit no env. */
  override: string | null
}

export function relayPanel(relay: RelaySetting | undefined): RelayPanel {
  if (relay === undefined) {
    return { headline: 'Reading where this project’s relay is…', detail: null, override: null }
  }

  const override = relay.override.value === null ? null : overrideSentence(relay, relay.override.value)

  if (relay.url === null) {
    return {
      headline: 'Teamwork has no relay to dial in this repository.',
      // The fallback is for a shape with neither URL nor reason, which must not render empty.
      detail: relay.problem ?? `Neither ${relay.file} nor ${relay.override.name} names one.`,
      override
    }
  }

  return {
    headline: `Teamwork dials ${relay.url}.`,
    detail:
      relay.source === 'environment' ? `From ${relay.override.name} in this app’s environment.` : `From ${relay.file}.`,
    override
  }
}

/** The environment beating the file, including that only a relaunch changes it. */
function overrideSentence(relay: RelaySetting, value: string): string {
  const { name } = relay.override
  const beaten = relay.onDisk.url === null ? `${relay.file} names no relay.` : `${relay.file} says ${relay.onDisk.url}.`
  return `${name} is set to ${value} in this app’s environment. ${beaten} Unset it and relaunch teamree.`
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
  const title = panel.promise === null ? null : `${panel.promise} ${panel.password ?? ''}`.trim()
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
