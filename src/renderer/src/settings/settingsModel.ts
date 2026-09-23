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
  /**
   * Which version this is, as a label rather than as a sentence.
   *
   * It used to be "This is teamree 0.2.0." with a paragraph under it saying
   * what pressing Check would do and that teamree installs nothing by itself.
   * Both are true and neither is something a developer looking at a version
   * number and a button needs told; the second lives in the comment on
   * `offersCheck` below and in `docs/`, where this repository keeps its
   * explanations. Where the build is not a release the fact is folded into the
   * label, because there is no button beside it to carry the meaning.
   */
  headline: string
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
      headline: 'teamree (version unknown)',
      offersCheck: false,
      lastChecked: null,
      problem: null
    }
  }

  const lastChecked = update.checkedAt === null ? null : checkedLabel(update.checkedAt, now)

  // A build that is not a release has nothing published to compare itself
  // against, so there is no button; the label says which build it is and why
  // there is nothing to press.
  if (!update.checkable) {
    return {
      headline: `teamree ${update.current} (not a release)`,
      offersCheck: false,
      lastChecked,
      problem: update.problem
    }
  }

  // What a check does, for anybody reading this rather than the screen: it asks
  // GitHub for the newest release and opens a browser at the disk image if
  // there is one. teamree installs nothing by itself and never replaces the
  // running app. None of that is on the page — the button says Check for
  // updates, and a developer knows what a check is.
  return {
    headline: `teamree ${update.current}`,
    offersCheck: true,
    lastChecked,
    problem: update.problem
  }
}

/**
 * How long ago the last check was.
 *
 * `sinceLabel` answers "now" for anything under ten seconds, which reads as a
 * duration everywhere else in this app and as nonsense in the phrase "checked
 * … ago" — so that one case gets its own wording rather than a number. A label
 * rather than a sentence: it sits beside the button that did the checking.
 */
function checkedLabel(checkedAt: number, now: number): string {
  const ago = sinceLabel(Math.max(0, now - checkedAt))
  return ago === 'now' ? 'Checked just now' : `Checked ${ago} ago`
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
