// What the install-CLI panel says in each state. The wording is the feature, so it is tested apart
// from the component.

import type { CliInstall, CliStatus } from '@shared/entities'

export type CliPanel = {
  /** What is true now, in one line. */
  headline: string
  /** Where the link leads, when that is not already the headline. */
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
  headline: 'Looking for the CLI…',
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
      headline: `Not installable on ${status.platform}`,
      manual: `sudo ln -sf ${status.source ?? '<the app>/resources/cli/teamree'} ${status.destination}`,
      pathWarning: pathWarning(status)
    }
  }

  if (status.source === null) {
    return {
      ...CLI_PANEL_READING,
      headline: 'No CLI in this build'
    }
  }

  // Ahead of everything: running from an image, every other sentence goes false on eject. No button.
  if (status.impermanent !== null) {
    return {
      ...CLI_PANEL_READING,
      headline: `Running from ${
        status.impermanent === 'volume' ? 'a disk image' : 'a translocated copy'
      } — move teamree to Applications`,
      detail: status.source
    }
  }

  if (status.bundle === null) {
    // Only a source checkout gets here. No button: a launcher with nothing behind it exits at once.
    return {
      ...CLI_PANEL_READING,
      headline: 'CLI not built',
      detail: status.source,
      manual: 'npm run build:cli'
    }
  }

  if (status.state === 'linked') {
    return {
      ...CLI_PANEL_READING,
      headline: 'On your PATH',
      detail: `${status.destination} → ${status.resolved ?? status.source}`,
      pathWarning: pathWarning(status)
    }
  }

  if (status.state === 'file' || status.state === 'directory') {
    const what = status.state === 'file' ? 'a regular file' : 'a directory'
    return {
      ...CLI_PANEL_READING,
      headline: `${status.destination} is ${what} — move it aside`,
      pathWarning: pathWarning(status)
    }
  }

  const password = status.needsAdministrator ? `Administrator password for ${status.directory}` : 'No password'

  if (status.state === 'elsewhere') {
    return {
      // Two failures: a link that drives the wrong app, and one into nothing.
      headline: status.dangling ? 'Broken link' : 'Linked to another copy',
      detail: `${status.destination} → ${status.resolved}${status.dangling ? ' (missing)' : ''}`,
      promise: `${status.destination} → ${status.source}`,
      password,
      action: 'Repair',
      manual: null,
      pathWarning: pathWarning(status)
    }
  }

  return {
    headline: 'Not on your PATH',
    detail: null,
    promise: `${status.destination} → ${status.source}`,
    password,
    action: 'Install',
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
  return panel.promise === null ? panel.headline : `${panel.headline} · ${panel.promise}`
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

/** The one unprompted offer after install, or null; its lines come from the panel so they agree. */
export type CliOffer = {
  headline: string
  promise: string
  password: string
  /** Opens the panel, where the link is actually made. */
  accept: string
  decline: string
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
          ? 'teamree on your PATH is a broken link'
          : 'teamree on your PATH is another copy'
        : 'Put the teamree command on your PATH?',
    promise: panel.promise,
    password: panel.password,
    accept: panel.action,
    decline: 'No Thanks'
  }
}

/** What just happened, and which PATH source vouches for it, so it is not heard as "it works". */
export function cliOutcome(install: CliInstall): string {
  const { status } = install
  const link = `${status.destination} → ${status.source}`
  const done =
    install.outcome === 'already-linked'
      ? `Already linked: ${link}`
      : install.outcome === 'replaced'
        ? `Linked ${link}, replacing ${install.replaced}`
        : `Linked ${link}`
  return `${done} · ${pathBasis(status)}`
}

/** Which PATH source confirmed the link. */
function pathBasis(status: CliStatus): string {
  if (status.onPath === 'environment') return `${status.directory} on the app’s PATH, not necessarily your terminal’s`
  // teamree reads the login shell's PATH back, the same probe every pane is built with.
  if (status.onPath === 'shell') return `${status.directory} on your login shell’s PATH`
  if (status.onPath === 'login') return `${status.directory} in /etc/paths (login shell not asked)`
  return `${status.directory} not on PATH`
}

/** Said only when neither this process's PATH nor `/etc/paths` includes the directory. */
function pathWarning(status: CliStatus): string | null {
  return status.onPath === null ? `${status.directory} not on PATH` : null
}
