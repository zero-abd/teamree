// What the window says about a newer release: ready to restart into when it was fetched in place, else
// a disk image to install by hand, pointing at the install document rather than repeating its advice.

import type { UpdateState } from '@shared/entities'

export type UpdateNotice = {
  /** What is true now, in one line. */
  headline: string
  /** What downloading gets you, and what it does not; null once a copy is ready to restart into. */
  detail: string | null
  /** The release notes, as text. Null when this release carries none here. */
  notes: string | null
  /** The button that opens the browser. */
  action: string
  /** The link to `INSTALL_DOCUMENT`. */
  install: string
  /** A copy of this release is fetched and verified; restarting installs it. */
  ready: boolean
}

/** Sent to, not repeated: verify-quarantine-advice.mjs checks the command in `docs/install.md`, not copies. */
export const INSTALL_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/docs/install.md'

/** The card, or null unless a check actually found a newer release. */
export function updateNotice(state: UpdateState | null): UpdateNotice | null {
  if (state === null || state.available === null) return null
  const release = state.available
  const ready = state.install?.state === 'ready' && state.install.version === release.version

  return {
    headline: `teamree ${release.version} is ${ready ? 'ready' : 'available'}`,
    detail: ready ? null : `Running ${state.current} · disk image, install by hand`,
    notes: release.notes,
    action: release.downloadUrl === null ? 'Open Release Page' : `Download ${release.version}`,
    install: 'Install steps',
    ready
  }
}

/** The palette's label for the preference: always an instruction, never a statement beside a tick. */
export function automaticUpdatesLabel(state: UpdateState | null): string {
  return state?.automatic === false ? 'Check for Updates Automatically' : 'Stop Checking for Updates Automatically'
}

/** The one button that gets the release: restart into a copy fetched in place, else the `.dmg`, else the browser. */
export type InstallerStep = {
  kind: 'browser' | 'fetch' | 'progress' | 'open' | 'restart'
  label: string
  /** Why the last download failed, in one line. */
  problem: string | null
}

export function installerStep(state: UpdateState | null): InstallerStep | null {
  const release = state?.available ?? null
  if (state === null || release === null) return null
  const install = state.install?.version === release.version ? state.install : null
  if (install?.state === 'ready') return { kind: 'restart', label: 'Restart to Update', problem: null }
  if (install?.state === 'downloading') return progress(install)
  const failed = install?.state === 'failed' ? install.problem : null
  if (!release.installer) return { kind: 'browser', label: updateNotice(state)?.action ?? '', problem: failed }

  const download = state.download?.version === release.version ? state.download : null
  if (download?.state === 'downloading') return progress(download)
  if (download?.state === 'ready') return { kind: 'open', label: 'Open Installer', problem: null }
  return { kind: 'fetch', label: 'Download', problem: download?.state === 'failed' ? download.problem : failed }
}

function progress({ received, total }: { received: number; total: number }): InstallerStep {
  return { kind: 'progress', label: `Downloading ${Math.floor((received * 100) / Math.max(total, 1))}%`, problem: null }
}
