import { describe, expect, it } from 'vitest'
import { AGENT_INSTALLS, otherHarnessNames } from './agentInstalls'
import { HARNESSES } from './harnesses'

describe('agent installs', () => {
  it('leads with Claude Code and Codex, one command line each', () => {
    expect(AGENT_INSTALLS.slice(0, 2).map((install) => install.kind)).toEqual(['claude', 'codex'])
    for (const install of AGENT_INSTALLS) {
      expect(Object.hasOwn(HARNESSES, install.kind)).toBe(true)
      expect(install.command).not.toContain('\n')
    }
  })

  it('names every other harness once, and none twice', () => {
    const named = [...AGENT_INSTALLS.map((install) => HARNESSES[install.kind].name), ...otherHarnessNames()]
    const every = Object.values(HARNESSES).map((harness) => harness.name)
    expect(named.sort()).toEqual(every.sort())
  })
})
