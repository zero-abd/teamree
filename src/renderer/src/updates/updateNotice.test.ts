// The wording, and the one thing it must never imply.
//
// A card that says "Update available" beside a button reads as an installer,
// and this one is not: the build is unsigned, so nothing can replace it in
// place. Everything below is about the card saying that before somebody presses
// anything, and about it staying quiet the rest of the time.

import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/entities'
import { INSTALL_DOCUMENT, automaticUpdatesLabel, installerStep, updateNotice } from './updateNotice'

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    current: '0.1.0',
    checkable: true,
    automatic: true,
    available: {
      version: '0.2.0',
      tag: 'v0.2.0',
      notes: 'Panes resize faster.',
      downloadUrl: 'https://github.com/zero-abd/teamree/releases/download/v0.2.0/teamree-mac-universal.dmg',
      releaseUrl: 'https://github.com/zero-abd/teamree/releases/tag/v0.2.0',
      publishedAt: 0
    },
    checking: false,
    checkedAt: 0,
    problem: null,
    ...overrides
  }
}

describe('what the card says', () => {
  it('names both versions, so it is clear what is being replaced', () => {
    const notice = updateNotice(state())
    expect(notice?.headline).toContain('0.2.0')
    expect(notice?.detail).toContain('0.1.0')
  })

  it('says teamree does not install it, in one line and without an argument for it', () => {
    const notice = updateNotice(state())
    expect(notice?.detail).toContain('install by hand')
    expect(notice?.detail).not.toContain('unsigned')
  })

  it('sends the reader to the install steps rather than reciting them', () => {
    // The quarantine command lives in docs/install.md, where a script runs it against a real build.
    expect(updateNotice(state())?.install).toBe('Install steps')
    expect(INSTALL_DOCUMENT).toMatch(/docs\/install\.md$/)
  })

  it('leaves stopping the checks to Settings', () => {
    expect(updateNotice(state())).not.toHaveProperty('silence')
  })

  it('offers the release page when there is no image to download', () => {
    const available = { ...state().available!, downloadUrl: null }
    expect(updateNotice(state({ available }))?.action).toBe('Open the release page')
    expect(updateNotice(state())?.action).toContain('0.2.0')
  })

  it('carries the notes through untouched, markup and all', () => {
    const notes = '### What changed\n- <b>bold</b> release notes'
    expect(updateNotice(state({ available: { ...state().available!, notes } }))?.notes).toBe(notes)
  })
})

describe('when it says nothing at all', () => {
  it('has nothing to show before anything has been asked', () => {
    expect(updateNotice(null)).toBeNull()
  })

  // Every one of these is "nothing for the user to do", and they must look the
  // same on screen, because to somebody working they are the same.
  it('has nothing to show when there is no newer release, whatever else happened', () => {
    expect(updateNotice(state({ available: null }))).toBeNull()
    expect(updateNotice(state({ available: null, problem: 'offline' }))).toBeNull()
    expect(updateNotice(state({ available: null, checkable: false }))).toBeNull()
  })
})

describe('the preference row', () => {
  it('reads as an instruction either way, never as a statement of what is set', () => {
    expect(automaticUpdatesLabel(state({ automatic: true }))).toBe('Stop checking for updates automatically')
    expect(automaticUpdatesLabel(state({ automatic: false }))).toBe('Check for updates automatically')
    // Before the runtime has answered, the default is what it will say.
    expect(automaticUpdatesLabel(null)).toBe('Stop checking for updates automatically')
  })
})

describe('the installer button', () => {
  const installer = { name: 'teamree-0.2.0.dmg', size: 1000 }
  const verifiable = (overrides: Partial<UpdateState> = {}): UpdateState =>
    state({ available: { ...state().available!, installer }, ...overrides })

  it('downloads in the app when the release gives a checksum, and in the browser when not', () => {
    expect(installerStep(verifiable())).toMatchObject({ kind: 'fetch', label: 'Download', problem: null })
    expect(installerStep(state())).toMatchObject({ kind: 'browser', label: 'Download 0.2.0' })
    expect(installerStep(state({ available: null }))).toBeNull()
  })

  it('goes Download, then progress, then Open Installer', () => {
    const downloading = { state: 'downloading' as const, version: '0.2.0', received: 420, total: 1000 }
    expect(installerStep(verifiable({ download: downloading }))).toMatchObject({
      kind: 'progress',
      label: 'Downloading 42%'
    })
    const ready = { state: 'ready' as const, version: '0.2.0', path: '/Users/me/Downloads/teamree-0.2.0.dmg' }
    expect(installerStep(verifiable({ download: ready }))).toMatchObject({ kind: 'open', label: 'Open Installer' })
  })

  it('offers Download again beside the one-line reason a download failed', () => {
    const failed = { state: 'failed' as const, version: '0.2.0', problem: 'Checksum mismatch; the file was deleted.' }
    expect(installerStep(verifiable({ download: failed }))).toMatchObject({
      kind: 'fetch',
      label: 'Download',
      problem: 'Checksum mismatch; the file was deleted.'
    })
  })

  it('ignores a download that was for an older release', () => {
    const ready = { state: 'ready' as const, version: '0.1.5', path: '/Users/me/Downloads/teamree-0.1.5.dmg' }
    expect(installerStep(verifiable({ download: ready }))).toMatchObject({ kind: 'fetch' })
  })
})
