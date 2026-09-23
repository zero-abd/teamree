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
  /** The link to `INSTALL_DOCUMENT`. */
  install: string
}

/** Sent to, not repeated: verify-quarantine-advice.mjs checks the command in `docs/install.md`, not copies. */
export const INSTALL_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/docs/install.md'

/** The card, or null unless a check actually found a newer release. */
export function updateNotice(state: UpdateState | null): UpdateNotice | null {
  if (state === null || state.available === null) return null
  const release = state.available

  return {
    headline: `teamree ${release.version} is available`,
    // An unsigned build cannot replace itself, so the download is a `.dmg` installed like this one.
    detail: `Running ${state.current} · disk image, install by hand`,
    notes: release.notes,
    action: release.downloadUrl === null ? 'Open the release page' : `Download ${release.version}`,
    install: 'Install steps'
  }
}

/** The palette's label for the preference: always an instruction, never a statement beside a tick. */
export function automaticUpdatesLabel(state: UpdateState | null): string {
  return state?.automatic === false ? 'Check for updates automatically' : 'Stop checking for updates automatically'
}

/** The one button that gets the release: in the app when it can be verified, else in the browser. */
export type InstallerStep = {
  kind: 'browser' | 'fetch' | 'progress' | 'open'
  label: string
  /** Why the last download failed, in one line. */
  problem: string | null
}

export function installerStep(state: UpdateState | null): InstallerStep | null {
  const release = state?.available ?? null
  if (state === null || release === null) return null
  if (!release.installer) return { kind: 'browser', label: updateNotice(state)?.action ?? '', problem: null }

  const download = state.download?.version === release.version ? state.download : null
  if (download?.state === 'downloading') {
    const percent = Math.floor((download.received * 100) / Math.max(download.total, 1))
    return { kind: 'progress', label: `Downloading ${percent}%`, problem: null }
  }
  if (download?.state === 'ready') return { kind: 'open', label: 'Open Installer', problem: null }
  return { kind: 'fetch', label: 'Download', problem: download?.state === 'failed' ? download.problem : null }
}
