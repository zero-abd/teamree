// What the install-CLI panel says in each state. The wording is the feature, so it is tested apart
// from the component.

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

/** What the CLI is for, in one sentence; shared by the first-run card and the dialog so they agree. */
export const CLI_PURPOSE = 'teamree ships a CLI that does everything this window can.'

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
      detail: `This is ${status.platform}. The command below does what the button would.`,
      manual: `sudo ln -sf ${status.source ?? '<the app>/resources/cli/teamree'} ${status.destination}`,
      pathWarning: pathWarning(status)
    }
  }

  if (status.source === null) {
    return {
      ...CLI_PANEL_READING,
      headline: 'This build of teamree has no CLI inside it.',
      detail: 'A packaged app carries its CLI in Contents/Resources/cli.'
    }
  }

  // Ahead of everything: running from an image, every other sentence goes false on eject. No button.
  if (status.impermanent !== null) {
    return {
      ...CLI_PANEL_READING,
      headline:
        status.impermanent === 'volume'
          ? 'teamree is running from a mounted volume.'
          : 'macOS is running teamree from a temporary copy of itself.',
      detail:
        (status.impermanent === 'volume'
          ? `It is at ${status.source}, so a link there dies when you eject. `
          : `The copy is at ${status.source}, and is gone by the next launch. `) +
        'Move teamree to Applications and open it from there.'
    }
  }

  if (status.bundle === null) {
    // Only a source checkout gets here. No button: a launcher with nothing behind it exits at once.
    return {
      ...CLI_PANEL_READING,
      headline: 'The teamree CLI has not been built yet.',
      detail: `${status.source} is the launcher; the bundle it runs is not there.`,
      manual: 'npm run build:cli'
    }
  }

  if (status.state === 'linked') {
    return {
      ...CLI_PANEL_READING,
      headline: 'teamree is on your PATH.',
      detail: `${status.destination} leads to this app’s CLI.`,
      pathWarning: pathWarning(status)
    }
  }

  if (status.state === 'file' || status.state === 'directory') {
    const what = status.state === 'file' ? 'a regular file' : 'a directory'
    return {
      ...CLI_PANEL_READING,
      headline: `There is ${what} at ${status.destination}.`,
      detail: 'Move it aside and open this again.',
      pathWarning: pathWarning(status)
    }
  }

  const password = status.needsAdministrator
    ? `macOS will ask for your administrator password; ${status.directory} needs one.`
    : `No password: ${status.directory} is writable as you.`

  if (status.state === 'elsewhere') {
    return {
      headline: status.dangling
        ? `${status.destination} leads to a teamree that is not there.`
        : `${status.destination} points at a different copy of teamree.`,
      // Two failures, opposite sentences: a link that drives the wrong app, and one into nothing.
      detail: status.dangling
        ? `It leads to ${status.resolved}, and nothing is there.`
        : `It leads to ${status.resolved}, so typing teamree drives that copy.`,
      promise: `Points ${status.destination} at this app’s CLI instead: ${status.source}.`,
      password,
      action: 'Point it at this app',
      manual: null,
      pathWarning: pathWarning(status)
    }
  }

  return {
    headline: 'The teamree CLI is not on your PATH yet.',
    // A checkout can move out from under the link; say so rather than "ships inside this app".
    detail: status.packaged
      ? `It ships inside this app, at ${status.source}.`
      : `It is at ${status.source}, in the checkout you are running from, so the link breaks if you move it.`,
    promise: `Links ${status.destination} to it.`,
    password,
    action: 'Put teamree on my PATH',
    manual: null,
    pathWarning: pathWarning(status)
  }
}

/** What the sidebar button and the palette entry call this; a dangling link is named, not re-offered. */
export function cliActionLabel(status: CliStatus | null): string {
  // From an image or translocated copy there is no action to name; the label points at the panel
  // that says to drag the app to Applications.
  if (status !== null && status.impermanent !== null) return 'Why teamree is not on your PATH'
  if (status?.state !== 'elsewhere') return 'Put teamree on my PATH'
  // A link into nothing is broken; a link into another copy drives the wrong app.
  return status.dangling ? 'Fix the broken teamree command' : 'Point teamree at this app'
}

/** The button's hover: what is wrong, then what pressing it (and its password prompt) does. */
export function cliTitle(status: CliStatus | null): string {
  const panel = cliPanel(status)
  return panel.promise === null ? panel.headline : `${panel.headline} ${panel.promise}`
}

/** Whether the sidebar offers this: only when there is something to do and doing it leaves a working command. */
export function offerCliInstall(status: CliStatus | null): boolean {
  return (
    status !== null &&
    status.installable &&
    status.source !== null &&
    status.bundle !== null &&
    status.state !== 'linked'
  )
}

/** The one unprompted offer after install, or null; its sentences come from the panel so they agree. */
export type CliOffer = {
  headline: string
  detail: string
  promise: string
  password: string
  /** Opens the panel, where the link is actually made. */
  accept: string
  decline: string
  /** That this is asked once, and where it lives afterwards. */
  once: string
}

/** Whether to ask at all: not when answered, nothing to do, a source checkout, or something is in the way. */
export function cliOffer(status: CliStatus | null): CliOffer | null {
  if (status === null || status.askedAt !== null || !status.packaged) return null
  if (!offerCliInstall(status)) return null
  const panel = cliPanel(status)
  if (panel.action === null || panel.promise === null || panel.password === null) return null

  return {
    headline:
      status.state === 'elsewhere'
        ? status.dangling
          ? 'The teamree command on your PATH leads to nothing.'
          : 'The teamree command on your PATH is a different copy.'
        : 'Put the teamree command on your PATH?',
    detail: CLI_PURPOSE,
    promise: panel.promise,
    password: panel.password,
    accept: panel.action,
    decline: 'No thanks',
    once: 'Asked once. The sidebar and the command palette both have it.'
  }
}

/** What just happened, said precisely enough that nobody has to guess. */
export function cliOutcome(install: CliInstall): string {
  const { status } = install
  const password = install.administrator ? ' An administrator password was given.' : ''
  const basis = ` ${pathBasis(status)}`
  if (install.outcome === 'already-linked') {
    return `${status.destination} already pointed at this app, so nothing was changed.${basis}`
  }
  if (install.outcome === 'replaced') {
    return (
      `${status.destination} now points at ${status.source}, and no longer at ${install.replaced}.` +
      `${password}${basis}`
    )
  }
  return `${status.destination} now points at ${status.source}.${password}${basis}`
}

/** Which PATH source confirmed the link, named so it is not heard as "it works". */
function pathBasis(status: CliStatus): string {
  if (status.onPath === 'environment') {
    return `${status.directory} is on this app’s PATH, which is not necessarily your terminal’s.`
  }
  // teamree reads the login shell's PATH back, the same probe every pane is built with.
  if (status.onPath === 'shell') {
    return `${status.directory} is on the PATH your login shell reports.`
  }
  if (status.onPath === 'login') {
    return `${status.directory} is in /etc/paths; your login shell could not be asked.`
  }
  return `Nothing teamree can read puts ${status.directory} on a PATH.`
}

/** Said only when neither this process's PATH nor `/etc/paths` includes the directory. */
function pathWarning(status: CliStatus): string | null {
  if (status.onPath !== null) return null
  return `Nothing teamree can read puts ${status.directory} on a PATH, so your shell may not find the command.`
}
