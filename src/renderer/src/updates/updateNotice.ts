// What the window says about a newer release. It never promises an install, and points at the install
// document rather than repeating the quarantine advice.

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

/** Sent to, not repeated: verify-quarantine-advice.mjs checks the command in `docs/install.md`, not copies. */
export const INSTALL_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/docs/install.md'

/** The card, or null unless a check actually found a newer release. */
export function updateNotice(state: UpdateState | null): UpdateNotice | null {
  if (state === null || state.available === null) return null
  const release = state.available

  return {
    headline: `teamree ${release.version} is available.`,
    // An unsigned build cannot replace itself, so the download is a `.dmg` installed like this one.
    detail: `You are running ${state.current}. The download is a disk image; teamree does not install it for you.`,
    notes: release.notes,
    action: release.downloadUrl === null ? 'Open the release page' : `Download ${release.version}`,
    silence: 'Stop checking',
    install: 'Install steps are in docs/install.md.'
  }
}

/** The palette's label for the preference: always an instruction, never a statement beside a tick. */
export function automaticUpdatesLabel(state: UpdateState | null): string {
  return state?.automatic === false ? 'Check for updates automatically' : 'Stop checking for updates automatically'
}
