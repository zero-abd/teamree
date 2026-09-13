// What the install-CLI panel says, in each state it can be in.
//
// Kept apart from the component for the reason the other dialog models are:
// the interesting part is the wording, and wording is worth testing. Three of
// these sentences carry the whole weight of the feature — the one that says a
// password is coming and why, before it is asked for; the one that says the
// link already exists and points at a *different* teamree, which is the failure
// nobody works out unaided; and the one that says this app cannot do it here,
// rather than offering a button that would fail.

import type { CliInstall, CliStatus } from '@shared/entities'

export type CliPanel = {
  /** What is true now, in one line. */
  headline: string
  /** The rest of it: what that means, or where the other copy is. */
  detail: string | null
  /** Exactly what pressing the button will do. Null when there is no button. */
  promise: string | null
  /** Whether a password is coming, and why. Null when nothing will ask. */
  password: string | null
  /** The button's label, or null when there is nothing this app can do here. */
  action: string | null
  /** What to type instead, when there is no button and typing would work. */
  manual: string | null
  /** Said when the command will not be found even once the link exists. */
  pathWarning: string | null
}

/** Shown while the first read is in flight, so the panel is never blank. */
export const CLI_PANEL_READING: CliPanel = {
  headline: 'Looking for the teamree CLI…',
  detail: null,
  promise: null,
  password: null,
  action: null,
  manual: null,
  pathWarning: null
}

export function cliPanel(status: CliStatus | null): CliPanel {
  if (status === null) return CLI_PANEL_READING

  if (!status.installable) {
    return {
      ...CLI_PANEL_READING,
      headline: 'teamree can only put its CLI on PATH for you on macOS.',
      detail:
        `This is ${status.platform}, where the app has no way to ask for the password the link needs. ` +
        'The command below does exactly what the button would.',
      manual: `sudo ln -sf ${status.source ?? '<the app>/resources/cli/teamree'} ${status.destination}`,
      pathWarning: pathWarning(status)
    }
  }

  if (status.source === null) {
    return {
      ...CLI_PANEL_READING,
      headline: 'This build of teamree has no CLI inside it.',
      detail:
        'There is nothing to link, so there is nothing to put on PATH. A packaged app carries its CLI in ' +
        'Contents/Resources/cli.'
    }
  }

  if (status.state === 'linked') {
    return {
      ...CLI_PANEL_READING,
      headline: 'teamree is on your PATH.',
      detail: `${status.destination} leads to this app’s CLI. There is nothing to do.`,
      pathWarning: pathWarning(status)
    }
  }

  if (status.state === 'file' || status.state === 'directory') {
    const what = status.state === 'file' ? 'a regular file' : 'a directory'
    return {
      ...CLI_PANEL_READING,
      headline: `There is ${what} at ${status.destination}.`,
      detail:
        `teamree will not delete it — it is somebody’s program, and quite possibly yours. Move it aside and ` +
        'open this again.',
      pathWarning: pathWarning(status)
    }
  }

  const password = status.needsAdministrator
    ? `macOS will ask for your administrator password, because ${status.directory} cannot be written without one. ` +
      'The dialog is the system’s own and the password never reaches teamree.'
    : `No password: ${status.directory} is writable as you.`

  if (status.state === 'elsewhere') {
    return {
      headline: `${status.destination} points at a different copy of teamree.`,
      // The confusing one, named: the command works, and it drives the wrong app.
      detail:
        `It leads to ${status.resolved}. Typing teamree in a terminal drives that copy — which is why work ` +
        'done there never shows up here.',
      promise: `Points ${status.destination} at this app’s CLI instead: ${status.source}.`,
      password,
      action: 'Point it at this app',
      manual: null,
      pathWarning: pathWarning(status)
    }
  }

  return {
    headline: 'The teamree CLI is not on your PATH yet.',
    detail:
      `It ships inside this app, at ${status.source}. Everything the window can do it can do, which is how a ` +
      'coding agent drives teamree.',
    promise: `Links ${status.destination} to it.`,
    password,
    action: 'Put teamree on my PATH',
    manual: null,
    pathWarning: pathWarning(status)
  }
}

/**
 * Whether the sidebar should offer this at all.
 *
 * Only while there is something to do about it. A CLI that is already linked
 * needs no button, and a platform or a build this app cannot serve needs an
 * explanation rather than an affordance — the palette still reaches the panel
 * for anybody who wants to check.
 */
export function offerCliInstall(status: CliStatus | null): boolean {
  return status !== null && status.installable && status.source !== null && status.state !== 'linked'
}

/** What just happened, said precisely enough that nobody has to guess. */
export function cliOutcome(install: CliInstall): string {
  const { status } = install
  const password = install.administrator ? ' An administrator password was given.' : ''
  if (install.outcome === 'already-linked') {
    return `${status.destination} already pointed at this app, so nothing was changed.`
  }
  if (install.outcome === 'replaced') {
    return (
      `${status.destination} now points at ${status.source}. It used to point at ${install.replaced}, ` +
      `and that copy is untouched.${password}`
    )
  }
  return `${status.destination} now points at ${status.source}.${password}`
}

/**
 * Said only when nothing this app can read puts the directory on a PATH.
 *
 * An app opened from Finder inherits no shell environment, so its own PATH
 * proves only the positive case; `/etc/paths` is the other half, and is what a
 * login shell is built from. With neither, the link will be made and the
 * command still will not be found, which is worth saying before it happens.
 */
function pathWarning(status: CliStatus): string | null {
  if (status.onPath !== null) return null
  return (
    `Nothing teamree can read puts ${status.directory} on a PATH — not this app’s environment, and not ` +
    '/etc/paths. The link will be made, but your shell may still not find the command until that directory is on it.'
  )
}
