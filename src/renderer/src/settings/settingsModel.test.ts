// The wording, apart from the page that shows it.
//
// The cases here are the ones a rendered page makes awkward to reach: a clock
// that has just ticked, an app that was launched with the override set in a
// checkout that names no relay of its own, and the read that has not come back
// yet. Each of them is a sentence that would otherwise be written once and
// never read again until it was wrong in front of somebody.

import { describe, expect, it } from 'vitest'
import type { CliStatus, RelaySetting, UpdateState } from '@shared/entities'
import { cliLine, labelMatches, relayPanel, updatePanel } from './settingsModel'

const NOW = 1_700_000_000_000

const update = (overrides: Partial<UpdateState> = {}): UpdateState => ({
  current: '1.4.0',
  checkable: true,
  automatic: true,
  available: null,
  checking: false,
  checkedAt: null,
  problem: null,
  ...overrides
})

const relay = (overrides: Partial<RelaySetting> = {}): RelaySetting => ({
  projectId: 'p1',
  file: '.teamree/relay',
  url: 'wss://relay.example/v1/relay',
  source: 'repository',
  problem: null,
  onDisk: { url: 'wss://relay.example/v1/relay', problem: null },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  deploy: { command: 'teamree-relay deploy', reason: null },
  readAt: 0,
  ...overrides
})

describe('what the page says about updates', () => {
  it('names the version and offers a check, and says nothing else', () => {
    const panel = updatePanel(update(), NOW)
    expect(panel.headline).toBe('teamree 1.4.0')
    expect(panel.offersCheck).toBe(true)
  })

  // The button is absent rather than disabled: there is nothing published to
  // compare a development build against, so a press could only ever come back
  // with the same non-answer.
  it('offers no check at all when there is nothing to compare against', () => {
    const panel = updatePanel(update({ current: '0.0.0-dev', checkable: false }), NOW)
    expect(panel.offersCheck).toBe(false)
    // In the label, because there is no button beside it to carry the meaning.
    expect(panel.headline).toBe('teamree 0.0.0-dev (not a release)')
  })

  it('says nothing about a version it has not been told yet', () => {
    const panel = updatePanel(null, NOW)
    expect(panel.offersCheck).toBe(false)
    expect(panel.lastChecked).toBeNull()
    expect(panel.headline).toBe('teamree (version unknown)')
  })

  it('counts from the last check', () => {
    expect(updatePanel(update({ checkedAt: NOW - 90 * 60_000 }), NOW).lastChecked).toBe('Checked 1h ago')
  })

  // `sinceLabel` answers "now" under ten seconds, and "checked now ago" is not
  // anything.
  it('does not say "now ago" about a check that has just run', () => {
    expect(updatePanel(update({ checkedAt: NOW - 2_000 }), NOW).lastChecked).toBe('Checked just now')
  })

  it('has no last check to report before one has ever run', () => {
    expect(updatePanel(update(), NOW).lastChecked).toBeNull()
  })
})

describe('what the page says about a relay', () => {
  it('names the file the URL came from, so it is clear the team shares it', () => {
    const panel = relayPanel(relay())
    expect(panel.headline).toBe('wss://relay.example/v1/relay')
    expect(panel.detail).toBe('From .teamree/relay')
    expect(panel.override).toBeNull()
  })

  it('says there is none, in the runtime’s own words about why', () => {
    const panel = relayPanel(
      relay({
        url: null,
        source: null,
        problem: 'no .teamree/relay',
        onDisk: { url: null, problem: null }
      })
    )
    expect(panel.headline).toBe('No .teamree/relay')
    expect(panel.detail).toBeNull()
  })

  it('says the environment is beating the file, and that a relaunch is the way back', () => {
    const panel = relayPanel(
      relay({
        url: 'wss://tunnel.example/v1/relay',
        source: 'environment',
        override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
      })
    )
    expect(panel.override).toBe(
      'TEAMREE_RELAY_URL=wss://tunnel.example/v1/relay overrides .teamree/relay (wss://relay.example/v1/relay) until unset and relaunched'
    )
  })

  // The same variable, in a checkout that names no relay of its own. Saying it
  // is overriding the repository there would be claiming a conflict that is not
  // happening.
  it('does not claim the environment is beating a file that names nothing', () => {
    const panel = relayPanel(
      relay({
        url: 'wss://tunnel.example/v1/relay',
        source: 'environment',
        problem: null,
        onDisk: { url: null, problem: 'no .teamree/relay' },
        override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
      })
    )
    expect(panel.override).toContain('overrides .teamree/relay (empty)')
  })

  it('says it is still reading rather than answering for a project it has not read', () => {
    const panel = relayPanel(undefined)
    expect(panel.headline).toContain('Reading')
    expect(panel.detail).toBeNull()
  })
})

describe('cliLine', () => {
  const status = (overrides: Partial<CliStatus> = {}): CliStatus => ({
    installable: true,
    platform: 'darwin',
    source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    packaged: true,
    bundle: '/Applications/teamree.app/Contents/Resources/cli/index.js',
    impermanent: null,
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: 'linked',
    resolved: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    dangling: false,
    needsAdministrator: true,
    onPath: 'login',
    askedAt: null,
    readAt: 0,
    ...overrides
  })

  it('is the link and where it leads, with nothing to do', () => {
    expect(cliLine(status())).toMatchObject({
      state: '/usr/local/bin/teamree → /Applications/teamree.app/Contents/Resources/cli/teamree',
      action: null
    })
  })

  it('is "Not installed" and Install', () => {
    expect(cliLine(status({ state: 'absent', resolved: null }))).toMatchObject({
      state: 'Not installed',
      action: 'Install'
    })
  })

  // Two failures under one state: a link to nothing, and a link to another copy.
  it('is the wrong destination and Repair', () => {
    expect(cliLine(status({ state: 'elsewhere', resolved: '/Volumes/old/teamree', dangling: true }))).toMatchObject({
      state: '/usr/local/bin/teamree → /Volumes/old/teamree (missing)',
      action: 'Repair'
    })
    expect(cliLine(status({ state: 'elsewhere', resolved: '/opt/teamree/cli/teamree' }))).toMatchObject({
      state: '/usr/local/bin/teamree → /opt/teamree/cli/teamree (another copy)',
      action: 'Repair'
    })
  })

  it('says when the link is right but no PATH teamree can read reaches it', () => {
    expect(cliLine(status({ onPath: null })).state).toBe(
      '/usr/local/bin/teamree → /Applications/teamree.app/Contents/Resources/cli/teamree · /usr/local/bin not on PATH'
    )
  })

  // The button carries a password prompt, and the hover is where that is said.
  it('says on the button what it does and whether a password is coming', () => {
    const line = cliLine(status({ state: 'absent', resolved: null }))
    expect(line.title).toMatch(/^\/usr\/local\/bin\/teamree → /)
    expect(line.title).toMatch(/Administrator password/)
  })

  it('has no button where this app cannot link, and says what to type', () => {
    expect(cliLine(status({ bundle: null, packaged: false }))).toMatchObject({
      state: 'Not built',
      action: null,
      manual: 'npm run build:cli'
    })
    expect(cliLine(status({ installable: false, platform: 'linux' }))).toMatchObject({
      state: 'Not installable on linux',
      action: null,
      manual: expect.stringContaining('ln -sf')
    })
    expect(cliLine(null)).toMatchObject({ state: 'Looking…', action: null })
  })
})

describe('the filter', () => {
  it('keeps a label holding the words anywhere, whatever their case', () => {
    expect(labelMatches('Copy on select', 'SELECT')).toBe(true)
    expect(labelMatches('Copy on select', '  on sel ')).toBe(true)
    expect(labelMatches('Copy on select', 'paste')).toBe(false)
  })

  it('keeps everything while empty', () => {
    expect(labelMatches('Cursor', '')).toBe(true)
    expect(labelMatches('Cursor', '   ')).toBe(true)
  })
})
