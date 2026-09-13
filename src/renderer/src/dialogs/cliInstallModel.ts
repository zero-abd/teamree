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

/**
 * What the CLI is for, in one sentence.
 *
 * A constant because two surfaces say it — the first-run card and the dialog it
 * opens — and they had already drifted into two wordings of the same claim,
 * which is how a reader comes to wonder whether they are two different claims.
 */
export const CLI_PURPOSE =
  'teamree ships its own CLI, and everything this window can do it can do — it is how a coding agent drives teamree.'

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

  // Ahead of the bundle and of the link itself, because this is about the app
  // rather than about either: from here every other sentence in this panel
  // would be true when it was read and false by the time the volume was
  // ejected. No button, which is also what keeps the first-run card quiet.
  if (status.impermanent !== null) {
    return {
      ...CLI_PANEL_READING,
      headline:
        status.impermanent === 'volume'
          ? 'teamree is running from a mounted volume.'
          : 'macOS is running teamree from a temporary copy of itself.',
      detail:
        (status.impermanent === 'volume'
          ? `It is at ${status.source}. A link there would stop leading anywhere the moment you ejected. `
          : `The copy is at ${status.source}, and it is gone by the next launch, taking any link into it with it. `) +
        'Drag teamree to your Applications folder, open it from there, and this can link the copy that stays.'
    }
  }

  if (status.bundle === null) {
    // A packaged app ships the bundle beside the launcher, so only a source
    // checkout reaches this — and `npm run dev` is exactly what puts it here.
    // No button: linking a launcher with nothing behind it produces a `teamree`
    // that exits on its first line, and on macOS it costs a password to do.
    return {
      ...CLI_PANEL_READING,
      headline: 'The teamree CLI has not been built yet.',
      detail:
        `${status.source} is the launcher; the bundle it runs is not there. Linking it would put a teamree on ` +
        'your PATH that cannot start.',
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
      detail: 'teamree will not delete it; it is somebody’s program. Move it aside and open this again.',
      pathWarning: pathWarning(status)
    }
  }

  const password = status.needsAdministrator
    ? `macOS will ask for your administrator password, because ${status.directory} cannot be written without one. ` +
      'The dialog is the system’s own and the password never reaches teamree.'
    : `No password: ${status.directory} is writable as you.`

  if (status.state === 'elsewhere') {
    return {
      headline: status.dangling
        ? `${status.destination} leads to a teamree that is not there.`
        : `${status.destination} points at a different copy of teamree.`,
      // Two failures under one state, and the sentences are opposites. The
      // confusing one is the command that works and drives the wrong app; the
      // other is a link whose app has been deleted or ejected, where the shell
      // does not run anything at all and says so.
      detail: status.dangling
        ? `It leads to ${status.resolved}, and nothing is there. Typing teamree in a terminal runs nothing.`
        : `It leads to ${status.resolved}. Typing teamree in a terminal drives that copy — which is why work ` +
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
    // A packaged app ships its CLI; a checkout is a directory somebody can move
    // out from under the link, which is the one thing they need told before they
    // make one. Saying "ships inside this app" of a checkout is the kind of
    // sentence that makes the panel's other sentences worth less.
    detail: status.packaged
      ? `It ships inside this app, at ${status.source}.`
      : `It is in the checkout you are running from, at ${status.source}. The link is to that path, so it breaks ` +
        'if you move the checkout.',
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
 * Only while there is something to do about it, and only while doing it would
 * leave a command that runs. A CLI that is already linked needs no button; a
 * platform or a build this app cannot serve needs an explanation rather than an
 * affordance; and a launcher whose bundle has not been built needs one build
 * command, not a privileged operation that ends in a broken link. The palette
 * still reaches the panel, which says which of those it is.
 */
export function offerCliInstall(status: CliStatus | null): boolean {
  return (
    status !== null &&
    status.installable &&
    status.source !== null &&
    status.bundle !== null &&
    status.state !== 'linked'
  )
}

/**
 * The offer made once, unprompted, to somebody who has just installed the app.
 *
 * Null when there is nothing to offer, which is most of the time. The two
 * sentences that matter — where the link goes and whether a password is coming
 * — are taken from the panel rather than written again, so the offer and the
 * thing it opens cannot come to say different things.
 */
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

/**
 * Whether to put the question at all, and in what words.
 *
 * Four reasons to stay quiet, and each of them is a case where asking would be
 * either useless or a lie: the question has been answered already; there is
 * nothing to do or no way to do it (`offerCliInstall`); this is a source
 * checkout, where the answer would be asked again on every `npm run dev` and
 * where the link would break the moment the checkout moved; or something is in
 * the way at the destination, which is a problem to explain rather than an
 * offer to make — the sidebar still carries it to the panel that explains it.
 */
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
      `${status.destination} now points at ${status.source}. It used to point at ${install.replaced}, ` +
      `and that copy is untouched.${password}${basis}`
    )
  }
  return `${status.destination} now points at ${status.source}.${password}${basis}`
}

/**
 * What the sentence above it is standing on.
 *
 * The link was read back and resolved, which is a fact about a link and not
 * about the command a terminal will find. Two things can be read from here —
 * this process's own PATH and `/etc/paths` — and a shell profile is neither, so
 * the one that answered is named rather than left to be heard as "it works".
 * Somebody whose dotfiles assign PATH instead of extending it is told where to
 * look on the same line that told them the link was made.
 */
function pathBasis(status: CliStatus): string {
  const checked =
    status.onPath === 'environment'
      ? `Checked against this app’s own PATH, which has ${status.directory} on it.`
      : status.onPath === 'login'
        ? `Checked against /etc/paths, which every login shell’s PATH is built from, and ${status.directory} is ` +
          'in it.'
        : `Nothing teamree can read puts ${status.directory} on a PATH.`
  return (
    `${checked} teamree cannot read your shell profile, so if one sets PATH rather than adds to it, teamree may ` +
    'still not be found in a terminal.'
  )
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
