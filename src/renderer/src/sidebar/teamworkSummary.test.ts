// The five reasons a project shows no teammates, kept apart.
//
// This is the file that stops the sidebar saying "offline" when a colleague
// shut a laptop, and stops it saying "off" when it has simply not asked yet.

import { describe, expect, it } from 'vitest'
import type { PeerLink, TeamworkStatus } from '@shared/entities'
import { ADD_KEY_BUTTON } from '../dialogs/startTeamwork'
import { teamworkSummary, TEAMWORK_BUTTON_LABEL } from './teamworkSummary'

function status(overrides: Partial<TeamworkStatus> = {}): TeamworkStatus {
  return {
    projectId: 'p1',
    relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
    disabledReason: null,
    origin: { ok: true },
    enrolled: true,
    links: [],
    readAt: 0,
    ...overrides
  }
}

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
    // An absent answer is not an answer. Rendering one as "off" would have the
    // app state something it has not established.
    expect(teamworkSummary(undefined)).toBeNull()
  })

  it('reads a project with no relay as something to set up, not something broken', () => {
    const summary = teamworkSummary(status({ disabledReason: 'no .teamree/relay in this project' }))
    expect(summary).toMatchObject({ tone: 'off', label: 'Teamwork off' })
    expect(summary?.detail).toContain('.teamree/relay')
  })

  it('distinguishes a relay it cannot reach from a teammate who is not connected', () => {
    const unreachable = teamworkSummary(status({ links: [link({ phase: 'unreachable' })] }))
    expect(unreachable).toMatchObject({ tone: 'problem', label: 'Relay unreachable' })
    // This one is somebody else's laptop, and saying "unreachable" would send
    // the reader to check their own network.
    const away = teamworkSummary(status({ links: [link({ phase: 'waiting' })] }))
    expect(away).toMatchObject({ tone: 'pending', label: 'Nobody connected' })
  })

  it('carries what a connecting link has to say, so a wake does not read as ordinary', () => {
    // "Connecting…" is right and it is not enough: a link that is connecting
    // because this machine has just woken up is the one case where the reader
    // needs to know that nothing is currently known about the teammate.
    const summary = teamworkSummary(
      status({
        links: [
          link({ phase: 'connecting', detail: 'this machine was asleep, so nothing is known about your teammate' })
        ]
      })
    )
    expect(summary).toMatchObject({ tone: 'pending', label: 'Connecting…' })
    expect(summary?.detail).toContain('this machine was asleep')
  })

  it('carries what a link that has waited too long has to say, under the same label', () => {
    // "Nobody connected" is still the right label — nothing has established
    // that anything is wrong — but a link that has waited across two hourly
    // rotations knows more than the header alone can hold.
    const summary = teamworkSummary(
      status({
        links: [
          link({
            handle: 'marcus',
            phase: 'waiting',
            detail: 'nobody has answered on this rendezvous across two hourly rotations'
          })
        ]
      })
    )
    expect(summary).toMatchObject({ tone: 'pending', label: 'Nobody connected' })
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
      })
    )
    expect(summary?.tone).toBe('problem')
    expect(summary?.label).toBe('Handshake failed')
    expect(summary?.detail).toContain('marcus')
  })

  it('counts who is up and who is away without calling the away ones a fault', () => {
    const summary = teamworkSummary(
      status({ links: [link({ handle: 'priya' }), link({ handle: 'marcus', phase: 'waiting' })] })
    )
    expect(summary).toMatchObject({ tone: 'live', label: '1 connected · 1 away' })
  })

  it('names the one cause that is this machine, rather than blaming the teammate', () => {
    // The roster has the teammate on it and not me, so every link is parked on
    // a rendezvous their machine has no key to compute. It waits forever, and
    // the phase alone would say "Nobody connected" — sending the reader to a
    // machine that is doing nothing wrong.
    const summary = teamworkSummary(status({ enrolled: false, links: [link({ handle: 'ana', phase: 'waiting' })] }))
    expect(summary).toMatchObject({ tone: 'off', label: 'Your key is not here' })
    expect(summary?.detail).toContain('.teamree/members')
    expect(summary?.detail).toContain('commit and push')
  })

  it('sends the reader to controls that exist, under the names they render with', () => {
    // This sentence is the only instruction a stuck reader gets, and it named a
    // Members dialog that the Start teamwork panel replaced. Both names now come
    // from the components that draw them, so the tooltip cannot name a control
    // that is not there — nor go on naming one that has been renamed.
    const detail = teamworkSummary(status({ enrolled: false }))?.detail
    expect(detail).toContain(TEAMWORK_BUTTON_LABEL)
    expect(detail).toContain(ADD_KEY_BUTTON)
  })

  it('still says which thing is not set up at all before it says whose key is missing', () => {
    // "No relay here" is the earlier thing to fix, and it is the one the
    // roster read could not get past.
    const summary = teamworkSummary(status({ enrolled: false, disabledReason: 'no .teamree/relay in this project' }))
    expect(summary).toMatchObject({ tone: 'off', label: 'Teamwork off' })
  })

  it('says an empty roster is an empty roster, not a connection problem', () => {
    expect(teamworkSummary(status({ links: [] }))).toMatchObject({
      tone: 'off',
      label: 'No teammates'
    })
  })

  it('names where the relay came from, because a surprising URL needs a source', () => {
    const fromEnv = teamworkSummary(
      status({
        relay: { url: 'ws://127.0.0.1:8787/v1/relay', source: 'environment' },
        links: [link({ phase: 'unreachable' })]
      })
    )
    expect(fromEnv?.detail).toContain('from the environment')
    const fromRepo = teamworkSummary(status({ links: [link({ phase: 'unreachable' })] }))
    expect(fromRepo?.detail).toContain('.teamree/relay')
  })
})
