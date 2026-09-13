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

  // `path.win32`, not `path.join`: this test names the platform it is about, and
  // the bare join follows whichever machine happens to be running the suite —
  // which is the same host-dependence that made discovery itself wrong.
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

  it('reads the real PATH when it is not given one', () => {
    // Nothing is asserted about what is installed here — only that asking the
    // machine directly does not throw.
    expect(() => findInstalledAgents()).not.toThrow()
  })
})

/** Runs the last argument it was given, whatever flags came before it. */
const LAST_ARGUMENT = 'shift $(($# - 1)); eval "$1"'

// Every test above hands discovery a PATH. The PATH it picks when nobody hands
// it one is the only one production ever uses, and it was the whole defect: on
// macOS an app opened from Finder or the Dock is started by launchd, whose
// environment does not have the user's profile in it, so an agent installed by
// brew or a version manager was invisible to the app while being right there in
// every pane the app opens. These tests are about that choice.
describe('findInstalledAgents without a PATH of its own', () => {
  const originalShell = process.env.SHELL
  const originalPath = process.env.PATH
  let dir = ''

  /**
   * What this process is started with for as long as these tests run: launchd's
   * own environment, which is what a Mac app opened from the Dock really is
   * handed.
   *
   * Pinned, and put back afterwards, for the same reason SHELL is. Each test
   * below asks which of two PATHs discovery ended up searching, and reading the
   * real one lets the machine running the suite answer that question instead of
   * the test: a GitHub macOS runner has Homebrew preinstalled and
   * /opt/homebrew/bin on PATH already, so the process PATH there holds the very
   * directory these tests use to mean "somewhere only the profile knew about".
   */
  const PROCESS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

  /** The install the process PATH can see, and the one a profile adds. */
  const INHERITED_CLAUDE = '/usr/bin/claude'
  const PROFILE_CLAUDE = '/opt/homebrew/bin/claude'

  /**
   * An agent sitting in both PATHs at once, so the binary that comes back names
   * the PATH that was searched — where an empty answer would only say discovery
   * searched nothing, which is what a broken fallback looks like too.
   */
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

  /**
   * A stand-in for the user's login shell, named so the real code recognises
   * it: a profile that greets them on stdout and complains on stderr, a PATH
   * only a login shell would have, and then whatever it was asked to run.
   */
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
    // What a profile really does: put its own directory in front of the PATH
    // the process already had. Finding the agent there is finding it somewhere
    // only the profile knew about.
    process.env.SHELL = await loginShell('zsh', `/opt/homebrew/bin:${PROCESS_PATH}`)

    const found = findInstalledAgents({ isExecutable: claudeInBoth })

    expect(found).toEqual([{ kind: 'claude', command: 'claude', binary: PROFILE_CLAUDE }])
  })

  it('falls back to the process PATH when the login shell answers with something else', async () => {
    process.env.SHELL = await loginShell('zsh', '/opt/homebrew/bin', "echo 'zsh: parse error'")

    // The install the unusable answer pointed at is not the one that comes
    // back, so that answer was thrown away; the one that does come back is on
    // the process PATH, so a PATH was still searched in its place.
    expect(findInstalledAgents({ isExecutable: claudeInBoth })).toEqual([
      { kind: 'claude', command: 'claude', binary: INHERITED_CLAUDE }
    ])
  })

  it('leaves a shell it does not know how to ask alone', async () => {
    process.env.SHELL = await loginShell('nu', '/opt/homebrew/bin')

    // A shell nobody asked cannot have contributed the PATH it would have
    // printed, and the process PATH answered instead.
    expect(findInstalledAgents({ isExecutable: claudeInBoth })).toEqual([
      { kind: 'claude', command: 'claude', binary: INHERITED_CLAUDE }
    ])
  })
})
