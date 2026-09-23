// The five reasons a project shows no teammates, kept apart: a shut laptop is not
// "offline", and "not asked yet" is not "off".

import { describe, expect, it } from 'vitest'
import type { PeerLink, TeamworkRead } from '@shared/entities'
import { ADD_KEY_BUTTON } from '../teamwork/startTeamwork'
import { teamworkControlLabel, teamworkSummary, TEAMWORK_BUTTON_LABEL } from './teamworkSummary'

function status(overrides: Partial<TeamworkRead> = {}): TeamworkRead {
  return {
    state: 'read',
    projectId: 'p1',
    relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
    disabledReason: null,
    origin: { ok: true, url: 'https://example.com/ada/pager.git' },
    enrolled: true,
    links: [],
    readAt: 0,
    ...overrides
  }
}

/** This machine's clock, as the sidebar's own tick hands it in. */
const NOW = 1_700_000_000_000

const link = (overrides: Partial<PeerLink> = {}): PeerLink => ({
  publicKey: 'k',
  handle: 'priya',
  phase: 'connected',
  since: 0,
  attempts: 1,
  ...overrides
})

describe('what the project header says about teamwork', () => {
  it('says nothing at all before it has asked', () => {
    // An absent answer is not an answer; "off" would state something not established.
    expect(teamworkSummary(undefined, NOW)).toBeNull()
  })

  it('separates "not read yet" from "nothing is configured here"', () => {
    // Not "off": nothing about this project has been read, so nothing may be named as missing.
    const summary = teamworkSummary({ state: 'unread', projectId: 'p1', readAt: NOW }, NOW)
    expect(summary).toMatchObject({ tone: 'pending' })
    expect(summary?.label).not.toContain('off')
    expect(summary?.detail).toContain('not read yet')
  })

  it('reads a project with no relay as something to set up, not something broken', () => {
    const summary = teamworkSummary(status({ disabledReason: 'no .teamree/relay in this project' }), NOW)
    expect(summary).toMatchObject({ tone: 'off', label: 'off' })
    expect(summary?.detail).toContain('.teamree/relay')
  })

  it('distinguishes a relay it cannot reach from a teammate who is not connected', () => {
    const unreachable = teamworkSummary(status({ links: [link({ phase: 'unreachable' })] }), NOW)
    expect(unreachable).toMatchObject({ tone: 'problem', label: 'relay unreachable' })
    // Somebody else's laptop; "unreachable" would send the reader to check their own network.
    const away = teamworkSummary(status({ links: [link({ phase: 'waiting' })] }), NOW)
    expect(away).toMatchObject({ tone: 'pending', label: 'nobody connected' })
  })

  it('carries what a connecting link has to say, so a wake does not read as ordinary', () => {
    // A link connecting because this machine just woke is the case where nothing is known about the teammate.
    const summary = teamworkSummary(
      status({
        links: [
          link({ phase: 'connecting', detail: 'this machine was asleep, so nothing is known about your teammate' })
        ]
      }),
      NOW
    )
    expect(summary).toMatchObject({ tone: 'pending', label: 'connecting…' })
    expect(summary?.detail).toContain('this machine was asleep')
  })

  it('gives a connected link both of the things it knows, not whichever was written last', () => {
    // Two independent facts: what the link says for itself, and how long since anything arrived.
    const woke = teamworkSummary(
      status({
        links: [
          link({
            phase: 'connecting',
            detail: 'this machine was asleep, so nothing is known about your teammate',
            lastHeardAt: NOW - 240_000
          })
        ]
      }),
      NOW
    )
    expect(woke?.detail).toContain('priya: this machine was asleep, so nothing is known about your teammate')
    expect(woke?.detail).toContain('last heard 4m ago')
    // And the phase is still what a link with nothing else to say falls back on.
    const plain = teamworkSummary(status({ links: [link({ lastHeardAt: NOW - 240_000 })] }), NOW)
    expect(plain?.detail).toBe('priya: connected, last heard 4m ago')
  })

  it('carries what a link that has waited too long has to say, under the same label', () => {
    // Still "nobody connected" — nothing is wrong — but a link that has waited two hourly rotations knows more.
    const summary = teamworkSummary(
      status({
        links: [
          link({
            handle: 'marcus',
            phase: 'waiting',
            detail: 'nobody has answered on this rendezvous across two hourly rotations'
          })
        ]
      }),
      NOW
    )
    expect(summary).toMatchObject({ tone: 'pending', label: 'nobody connected' })
    expect(summary?.detail).toContain('marcus: nobody has answered on this rendezvous')
  })

  it('puts a failed handshake above everything, without claiming somebody was there', () => {
    const summary = teamworkSummary(
      status({
        links: [
          link({ handle: 'priya' }),
          link({
            handle: 'marcus',
            phase: 'refused',
            detail: 'the peer static key is not on the roster'
          })
        ]
      }),
      NOW
    )
    expect(summary?.tone).toBe('problem')
    expect(summary?.label).toBe('handshake failed')
    expect(summary?.detail).toContain('marcus')
  })

  it('counts who is up and who is away without calling the away ones a fault', () => {
    const summary = teamworkSummary(
      status({ links: [link({ handle: 'priya' }), link({ handle: 'marcus', phase: 'waiting' })] }),
      NOW
    )
    expect(summary).toMatchObject({ tone: 'live', label: '1 connected · 1 away' })
  })

  it('says how long a connected link has been silent, once that is longer than silence ordinarily lasts', () => {
    // "Connected" cannot say that nothing has arrived for four of the five minutes before teardown;
    // the link carries `lastHeardAt` only once that is worth saying.
    const talking = teamworkSummary(status({ links: [link({ handle: 'priya' })] }), NOW)
    expect(talking?.label).toBe('1 connected')

    const silent = teamworkSummary(status({ links: [link({ handle: 'priya', lastHeardAt: NOW - 245_000 })] }), NOW)
    expect(silent).toMatchObject({ tone: 'live', label: '1 connected · silent 4m' })
    expect(silent?.detail).toContain('priya: connected, last heard 4m ago')

    // Rounded down, like every other age in this sidebar.
    const nearly = teamworkSummary(status({ links: [link({ handle: 'priya', lastHeardAt: NOW - 299_000 })] }), NOW)
    expect(nearly?.label).toBe('1 connected · silent 4m')

    // The worst silence among the links that are up, beside the count of the ones that are not.
    const mixed = teamworkSummary(
      status({
        links: [
          link({ handle: 'priya', lastHeardAt: NOW - 190_000 }),
          link({ handle: 'ana', lastHeardAt: NOW - 260_000 }),
          link({ handle: 'marcus', phase: 'waiting' })
        ]
      }),
      NOW
    )
    expect(mixed?.label).toBe('2 connected · 1 away · silent 4m')
  })

  it('names the one cause that is this machine, rather than blaming the teammate', () => {
    // The roster has the teammate and not me: every link waits on a rendezvous their machine cannot
    // compute, and the phase alone would send the reader to a machine doing nothing wrong.
    const summary = teamworkSummary(
      status({ enrolled: false, links: [link({ handle: 'ana', phase: 'waiting' })] }),
      NOW
    )
    expect(summary).toMatchObject({ tone: 'off', label: 'no key' })
    expect(summary?.detail).toContain('.teamree/members')
    expect(summary?.detail).toContain('Add my key')
  })

  it('sends the reader to controls that exist, under the names they render with', () => {
    // Both names come from the components that draw them, so the tooltip cannot name a control that is not there.
    const detail = teamworkSummary(status({ enrolled: false }), NOW)?.detail
    expect(detail).toContain(TEAMWORK_BUTTON_LABEL)
    expect(detail).toContain(ADD_KEY_BUTTON)
  })

  it('still says which thing is not set up at all before it says whose key is missing', () => {
    // "No relay here" is the earlier thing to fix.
    const summary = teamworkSummary(
      status({ enrolled: false, disabledReason: 'no .teamree/relay in this project' }),
      NOW
    )
    expect(summary).toMatchObject({ tone: 'off', label: 'off' })
  })

  it('says an empty roster is an empty roster, not a connection problem', () => {
    expect(teamworkSummary(status({ links: [] }), NOW)).toMatchObject({
      tone: 'off',
      label: 'no teammates'
    })
  })

  // One control whose text is the state; a chip and a button saying the same word was two things to guess between.
  it('folds the state into the control’s own label, and reads as the plain word until there is one', () => {
    expect(teamworkControlLabel(null)).toBe(TEAMWORK_BUTTON_LABEL)
    expect(teamworkControlLabel(teamworkSummary(status({ disabledReason: 'no relay' }), NOW))).toBe('Teamwork · off')
    expect(teamworkControlLabel(teamworkSummary(status({ links: [link()] }), NOW))).toBe('Teamwork · 1 connected')
  })

  // Read at a glance beside a branch name: a state, not a sentence.
  it('keeps every label a lower-case state, never a sentence', () => {
    const labels = [
      teamworkSummary({ state: 'unread', projectId: 'p1', readAt: NOW }, NOW),
      teamworkSummary(status({ disabledReason: 'no relay' }), NOW),
      teamworkSummary(status({ enrolled: false }), NOW),
      teamworkSummary(status({ links: [] }), NOW),
      teamworkSummary(status({ links: [link({ phase: 'refused' })] }), NOW),
      teamworkSummary(status({ links: [link({ phase: 'stopped' })] }), NOW),
      teamworkSummary(status({ links: [link({ phase: 'unreachable' })] }), NOW),
      teamworkSummary(status({ links: [link({ phase: 'waiting' })] }), NOW),
      teamworkSummary(status({ links: [link({ phase: 'connecting' })] }), NOW),
      teamworkSummary(status({ links: [link()] }), NOW)
    ].map((summary) => summary?.label ?? '')
    for (const label of labels) {
      expect(label, label).toMatch(/^[a-z0-9]/)
      expect(label, label).not.toMatch(/\.$/)
      expect(label.length, label).toBeLessThanOrEqual(24)
    }
  })

  it('names where the relay came from, because a surprising URL needs a source', () => {
    const fromEnv = teamworkSummary(
      status({
        relay: { url: 'ws://127.0.0.1:8787/v1/relay', source: 'environment' },
        links: [link({ phase: 'unreachable' })]
      }),
      NOW
    )
    expect(fromEnv?.detail).toContain('from the environment')
    const fromRepo = teamworkSummary(status({ links: [link({ phase: 'unreachable' })] }), NOW)
    expect(fromRepo?.detail).toContain('.teamree/relay')
  })
})
