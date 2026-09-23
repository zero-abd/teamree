// What the window says about a newer release, in each state it can be in.
//
// Kept apart from the card for the reason the other models here are: the
// interesting part is the wording, and wording is worth testing. Two sentences
// carry the weight of the feature and both are about not overpromising — the
// one that says teamree cannot install this for you, and the one that sends the
// reader to the install document rather than reciting half of it in a card 320
// pixels wide, where the quarantine advice would have to be repeated and would
// then be a third copy of it to keep in step.

import type { UpdateState } from '@shared/entities'

export type UpdateNotice = {
  /** What is true now, in one line. */
  headline: string
  /** What downloading gets you, and what it does not. */
  detail: string
  /** The release notes, as text. Null when this release carries none here. */
  notes: string | null
  /** The button that opens the browser. */
  action: string
  /** The quieter one, which stops teamree looking. */
  silence: string
  /** Where the install steps are, said as a sentence rather than a link. */
  install: string
}

/**
 * Sent to rather than repeated.
 *
 * `docs/install.md` is the one place the quarantine command lives, and
 * `scripts/verify-quarantine-advice.mjs` runs that command against a real
 * packaged build to prove it still works. A copy of it in this card would be a
 * copy that check does not read — which is precisely the arrangement where one
 * gets fixed and the other does not.
 */
export const INSTALL_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/docs/install.md'

/**
 * The card, or null when there is nothing worth interrupting anybody for.
 *
 * Null is the answer almost always, and deliberately: this returns something
 * only when a check has actually found a newer release. A check that failed, a
 * check that has not run, and a build that is already current all look the same
 * from here, because to the person working they are the same — nothing to do.
 */
export function updateNotice(state: UpdateState | null): UpdateNotice | null {
  if (state === null || state.available === null) return null
  const release = state.available

  return {
    headline: `teamree ${release.version} is available.`,
    // The second sentence is the honest one, and it is why this card exists in
    // this shape at all: an unsigned build cannot be replaced in place, so the
    // download is a `.dmg` the reader installs the way they installed this one.
    detail: `You are running ${state.current}. The download is a disk image; teamree does not install it for you.`,
    notes: release.notes,
    action: release.downloadUrl === null ? 'Open the release page' : `Download ${release.version}`,
    silence: 'Stop checking',
    install: 'Install steps are in docs/install.md.'
  }
}

/**
 * The palette's label for the preference, which says what pressing it does
 * rather than what is currently true.
 *
 * A row reading "Check for updates automatically" beside a tick is a row people
 * read as a statement and press as a question. This one is always an
 * instruction, so there is nothing to misread.
 */
export function automaticUpdatesLabel(state: UpdateState | null): string {
  return state?.automatic === false ? 'Check for updates automatically' : 'Stop checking for updates automatically'
}
