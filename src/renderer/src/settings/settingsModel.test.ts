// The wording, apart from the page that shows it.
//
// The cases here are the ones a rendered page makes awkward to reach: a clock
// that has just ticked, an app that was launched with the override set in a
// checkout that names no relay of its own, and the read that has not come back
// yet. Each of them is a sentence that would otherwise be written once and
// never read again until it was wrong in front of somebody.

import { describe, expect, it } from 'vitest'
import type { RelaySetting, UpdateState } from '@shared/entities'
import { relayPanel, updatePanel } from './settingsModel'

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
  it('offers a check, and says what pressing it does and does not do', () => {
    const panel = updatePanel(update(), NOW)
    expect(panel.headline).toBe('This is teamree 1.4.0.')
    expect(panel.offersCheck).toBe(true)
    expect(panel.detail).toContain('installs nothing by itself')
  })

  // The button is absent rather than disabled: there is nothing published to
  // compare a development build against, so a press could only ever come back
  // with the same non-answer.
  it('offers no check at all when there is nothing to compare against', () => {
    const panel = updatePanel(update({ current: '0.0.0-dev', checkable: false }), NOW)
    expect(panel.offersCheck).toBe(false)
    expect(panel.detail).toContain('Not a released version')
  })

  it('says nothing about a version it has not been told yet', () => {
    const panel = updatePanel(null, NOW)
    expect(panel.offersCheck).toBe(false)
    expect(panel.lastChecked).toBeNull()
    expect(panel.headline).toContain('has not said which version')
  })

  it('counts from the last check', () => {
    expect(updatePanel(update({ checkedAt: NOW - 90 * 60_000 }), NOW).lastChecked).toBe('Last checked 1h ago.')
  })

  // `sinceLabel` answers "now" under ten seconds, and "last checked now ago" is
  // not a sentence.
  it('does not say "now ago" about a check that has just run', () => {
    expect(updatePanel(update({ checkedAt: NOW - 2_000 }), NOW).lastChecked).toBe('Checked just now.')
  })

  it('has no last check to report before one has ever run', () => {
    expect(updatePanel(update(), NOW).lastChecked).toBeNull()
  })
})

describe('what the page says about a relay', () => {
  it('names the file the URL came from, so it is clear the team shares it', () => {
    const panel = relayPanel(relay())
    expect(panel.headline).toBe('Teamwork dials wss://relay.example/v1/relay.')
    expect(panel.detail).toBe('From .teamree/relay.')
    expect(panel.override).toBeNull()
  })

  it('says there is none, in the runtime’s own words about why', () => {
    const panel = relayPanel(
      relay({
        url: null,
        source: null,
        problem: 'no .teamree/relay in this project',
        onDisk: { url: null, problem: null }
      })
    )
    expect(panel.headline).toContain('no relay to dial')
    expect(panel.detail).toBe('no .teamree/relay in this project')
  })

  it('says the environment is beating the file, and that a relaunch is the way back', () => {
    const panel = relayPanel(
      relay({
        url: 'wss://tunnel.example/v1/relay',
        source: 'environment',
        override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
      })
    )
    expect(panel.override).toContain('.teamree/relay says wss://relay.example/v1/relay')
    expect(panel.override).toContain('Unset it and relaunch teamree')
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
        onDisk: { url: null, problem: 'no .teamree/relay in this project' },
        override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
      })
    )
    expect(panel.override).toContain('.teamree/relay names no relay')
    expect(panel.override).not.toContain('says wss://')
  })

  it('says it is still reading rather than answering for a project it has not read', () => {
    const panel = relayPanel(undefined)
    expect(panel.headline).toContain('Reading')
    expect(panel.detail).toBeNull()
  })
})
