// The runtime's catalogue of harnesses and the renderer's marks for them are one list kept in two
// processes; this is where the two are held to each other.

import { describe, expect, it } from 'vitest'
import { AGENT_KINDS, agentExecutables } from '../../../main/terminals/agent-command'
import { HARNESSES } from './harnesses'

describe('the harness registry', () => {
  it('gives every kind the runtime can start a name, a mark and an executable', () => {
    for (const kind of AGENT_KINDS) {
      expect(HARNESSES[kind].name.length, kind).toBeGreaterThan(0)
      expect(HARNESSES[kind].path, kind).toMatch(/^M/i)
      expect(agentExecutables(kind).length, kind).toBeGreaterThan(0)
    }
  })

  it('lists the marks in the runtime’s own order, and no mark for a kind it does not know', () => {
    expect(Object.keys(HARNESSES)).toEqual(AGENT_KINDS)
  })

  // A harness's name is the aria-label; the vendor's word, never the app's description of it.
  it('names each harness in a few words', () => {
    for (const kind of AGENT_KINDS) expect(HARNESSES[kind].name.split(' ').length, kind).toBeLessThanOrEqual(2)
  })
})
