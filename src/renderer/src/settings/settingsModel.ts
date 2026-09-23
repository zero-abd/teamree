// The two things on the settings page that are not a plain value being shown:
// whether this build has anything to check for an update against, and where a
// project's relay is actually coming from.
//
// Kept apart from the component for the reason `dialogs/cliInstallModel.ts` is:
// the interesting part is the wording, and wording is worth testing. Both of
// these are sentences somebody reads when the app is not doing what they
// expected, which is the worst moment to be vague at them — the one that says
// this build cannot be compared against anything, so the absence of a check
// button is a fact rather than a bug; and the one that says an environment
// variable is beating the file they just edited, which is the failure nobody
// works out unaided because the file on screen is correct and ignored.

import type { RelaySetting, UpdateState } from '@shared/entities'
import { sinceLabel } from '../sidebar/agentRows'

export type UpdatePanel = {
  /** Which version this is, in one line. */
  headline: string
  /** What a check does, or why there is nothing for one to do. */
  detail: string
  /**
   * Whether to put a check button on screen at all.
   *
   * False is not a disabled button with a tooltip: a build that is not a
   * release has nothing published to compare itself with, so the honest thing
   * is to say that and offer nothing, rather than to offer a press that can
   * only ever come back with the same non-answer.
   */
  offersCheck: boolean
  /** When the last check was, in words. Null when none has ever run. */
  lastChecked: string | null
  /** Why the last check produced no answer, or null when it did. */
  problem: string | null
}

export function updatePanel(update: UpdateState | null, now: number): UpdatePanel {
  // The runtime answers this read on connect, so a null here is a window that
  // has not been told yet rather than a build with no version. Saying "not a
  // release" of it would be inventing an answer out of a silence.
  if (update === null) {
    return {
      headline: 'teamree has not said which version this is yet.',
      detail: 'Waiting on the runtime.',
      offersCheck: false,
      lastChecked: null,
      problem: null
    }
  }

  const lastChecked = update.checkedAt === null ? null : checkedLabel(update.checkedAt, now)

  if (!update.checkable) {
    return {
      headline: `This is teamree ${update.current}.`,
      detail: 'Not a released version, so there is nothing published to compare it against.',
      offersCheck: false,
      lastChecked,
      problem: update.problem
    }
  }

  return {
    headline: `This is teamree ${update.current}.`,
    // What the button does and, just as much, what it does not: teamree opens
    // a browser at a disk image. Nothing here replaces the running app, and a
    // sentence that left that out would be promising an installer.
    detail: 'A check asks GitHub for the newest release. teamree installs nothing by itself.',
    offersCheck: true,
    lastChecked,
    problem: update.problem
  }
}

/**
 * How long ago the last check was.
 *
 * `sinceLabel` answers "now" for anything under ten seconds, which reads as a
 * duration everywhere else in this app and as nonsense in the phrase "last
 * checked … ago" — so that one case gets its own sentence rather than a number.
 */
function checkedLabel(checkedAt: number, now: number): string {
  const ago = sinceLabel(Math.max(0, now - checkedAt))
  return ago === 'now' ? 'Checked just now.' : `Last checked ${ago} ago.`
}

export type RelayPanel = {
  /** What teamwork would dial, in one line. */
  headline: string
  /** Where that came from, or why there is nothing. Null while it is unknown. */
  detail: string | null
  /**
   * Said only when this process was started with the override set.
   *
   * Null the rest of the time, which is almost always. An app opened from
   * Finder inherits no shell environment at all, and a paragraph about a
   * variable nobody set would be noise on every other machine.
   */
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
      // `problem` is the runtime's own account of why, written to be acted on.
      // The fallback is for a shape that carries neither a URL nor a reason,
      // which should not happen and must not render an empty paragraph if it
      // does.
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

/**
 * The environment beating the file, said in full.
 *
 * Three facts, and the third is the one that keeps somebody from hunting for a
 * control this page does not have: the variable was read out of the process
 * teamree was started in, and nothing inside a running app can change what it
 * was launched with. The way out is a relaunch, so the way out is named.
 */
function overrideSentence(relay: RelaySetting, value: string): string {
  const { name } = relay.override
  const beaten = relay.onDisk.url === null ? `${relay.file} names no relay.` : `${relay.file} says ${relay.onDisk.url}.`
  return `${name} is set to ${value} in this app’s environment. ${beaten} Unset it and relaunch teamree.`
}
