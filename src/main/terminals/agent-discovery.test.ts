import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findInstalledAgents } from './agent-discovery'

/** A fake PATH where only the named files exist and are runnable. */
const only =
  (...present: string[]) =>
  (candidate: string): boolean =>
    present.includes(candidate)

describe('findInstalledAgents', () => {
  it('finds what is on PATH and says nothing about what is not', () => {
    const found = findInstalledAgents({
      pathValue: '/usr/local/bin:/usr/bin',
      platform: 'linux',
      isExecutable: only('/usr/local/bin/claude', '/usr/bin/codex')
    })

    expect(found).toEqual([
      { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
      { kind: 'codex', command: 'codex', binary: '/usr/bin/codex' }
    ])
  })

  it('comes back empty rather than guessing when nothing is installed', () => {
    expect(findInstalledAgents({ pathValue: '/usr/bin', platform: 'linux', isExecutable: () => false })).toEqual([])
  })

  // The one a shell would run is the one to offer; a second install further
  // down PATH is not the one that would start.
  it('takes the first match, the way a shell resolves it', () => {
    const found = findInstalledAgents({
      pathValue: '/first:/second',
      platform: 'linux',
      isExecutable: only('/first/claude', '/second/claude')
    })

    expect(found[0]?.binary).toBe('/first/claude')
  })

  it('ignores an empty PATH entry rather than searching the working directory', () => {
    const found = findInstalledAgents({
      pathValue: ':/usr/bin:',
      platform: 'linux',
      isExecutable: only('claude', '/usr/bin/claude')
    })

    expect(found.map((agent) => agent.binary)).toEqual(['/usr/bin/claude'])
  })

  it('looks for the Windows extensions, on the Windows separator', () => {
    const found = findInstalledAgents({
      pathValue: 'C:\\tools;C:\\other',
      platform: 'win32',
      pathExt: '.EXE;.CMD',
      isExecutable: only(path.join('C:\\other', 'claude.CMD'))
    })

    expect(found).toEqual([{ kind: 'claude', command: 'claude', binary: path.join('C:\\other', 'claude.CMD') }])
  })

  it('keeps the catalogue order, so the list does not reshuffle between reads', () => {
    const found = findInstalledAgents({
      pathValue: '/bin',
      platform: 'linux',
      isExecutable: only('/bin/droid', '/bin/claude', '/bin/gemini')
    })

    expect(found.map((agent) => agent.kind)).toEqual(['claude', 'gemini', 'droid'])
  })

  it('reads the real PATH when it is not given one', () => {
    // Nothing is asserted about what is installed here — only that asking the
    // machine directly does not throw.
    expect(() => findInstalledAgents()).not.toThrow()
  })
})
