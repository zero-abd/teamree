import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findInstalledAgents } from './agent-discovery'
import { resetLoginShellPathCache } from './shell-environment'

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

  // `path.win32`, not `path.join`: the bare join follows the host running the suite.
  it('looks for the Windows extensions, on the Windows separator', () => {
    const binary = path.win32.join('C:\\other', 'claude.CMD')
    const found = findInstalledAgents({
      pathValue: 'C:\\tools;C:\\other',
      platform: 'win32',
      pathExt: '.EXE;.CMD',
      isExecutable: only(binary)
    })

    expect(found).toEqual([{ kind: 'claude', command: 'claude', binary }])
  })

  it('keeps the catalogue order, so the list does not reshuffle between reads', () => {
    const found = findInstalledAgents({
      pathValue: '/bin',
      platform: 'linux',
      isExecutable: only('/bin/droid', '/bin/claude', '/bin/gemini')
    })

    expect(found.map((agent) => agent.kind)).toEqual(['claude', 'gemini', 'droid'])
  })

  it('runs a harness by the executable it was found under', () => {
    const found = findInstalledAgents({
      pathValue: '/bin',
      platform: 'linux',
      isExecutable: only('/bin/kiro-cli', '/bin/kilocode')
    })

    expect(found).toEqual([
      { kind: 'kilo', command: 'kilocode', binary: '/bin/kilocode' },
      { kind: 'kiro', command: 'kiro-cli', binary: '/bin/kiro-cli' }
    ])
  })

  it('reads the real PATH when it is not given one', () => {
    expect(() => findInstalledAgents()).not.toThrow()
  })
})

/** Runs the last argument it was given, whatever flags came before it. */
const LAST_ARGUMENT = 'shift $(($# - 1)); eval "$1"'

// The PATH discovery picks on its own is the only one production uses: an app
// opened from the Dock is started by launchd, without the user's profile, so a
// brew-installed agent was invisible to the app and present in every pane.
describe('findInstalledAgents without a PATH of its own', () => {
  const originalShell = process.env.SHELL
  const originalPath = process.env.PATH
  let dir = ''

  /**
   * launchd's own environment, pinned: a GitHub macOS runner already has
   * /opt/homebrew/bin on PATH, the directory these tests use to mean "profile only".
   */
  const PROCESS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

  /** The install the process PATH can see, and the one a profile adds. */
  const INHERITED_CLAUDE = '/usr/bin/claude'
  const PROFILE_CLAUDE = '/opt/homebrew/bin/claude'

  /** An agent in both PATHs at once, so the binary that comes back names the PATH searched. */
  const claudeInBoth = only(PROFILE_CLAUDE, INHERITED_CLAUDE)

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-login-shell-'))
    process.env.PATH = PROCESS_PATH
    resetLoginShellPathCache()
  })

  afterEach(async () => {
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    resetLoginShellPathCache()
    await rm(dir, { recursive: true, force: true })
  })

  /** A stand-in login shell: greets on stdout, complains on stderr, sets a PATH, runs what it was asked. */
  const loginShell = async (name: string, loginPath: string, body = LAST_ARGUMENT): Promise<string> => {
    const file = path.join(dir, name)
    await writeFile(
      file,
      `#!/bin/sh\necho 'Last login: yesterday'\necho 'nvm: v20.11.0' >&2\nPATH='${loginPath}'\nexport PATH\n${body}\n`,
      'utf8'
    )
    await chmod(file, 0o755)
    return file
  }

  it('searches the login shell PATH, not the one this process was started with', async () => {
    // What a profile really does: its own directory in front of the process PATH.
    process.env.SHELL = await loginShell('zsh', `/opt/homebrew/bin:${PROCESS_PATH}`)

    const found = findInstalledAgents({ isExecutable: claudeInBoth })

    expect(found).toEqual([{ kind: 'claude', command: 'claude', binary: PROFILE_CLAUDE }])
  })

  it('falls back to the process PATH when the login shell answers with something else', async () => {
    process.env.SHELL = await loginShell('zsh', '/opt/homebrew/bin', "echo 'zsh: parse error'")

    // The unusable answer was thrown away, and the process PATH searched instead.
    expect(findInstalledAgents({ isExecutable: claudeInBoth })).toEqual([
      { kind: 'claude', command: 'claude', binary: INHERITED_CLAUDE }
    ])
  })

  it('leaves a shell it does not know how to ask alone', async () => {
    process.env.SHELL = await loginShell('nu', '/opt/homebrew/bin')

    expect(findInstalledAgents({ isExecutable: claudeInBoth })).toEqual([
      { kind: 'claude', command: 'claude', binary: INHERITED_CLAUDE }
    ])
  })
})
