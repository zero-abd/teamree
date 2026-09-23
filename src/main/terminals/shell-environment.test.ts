import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildShellCommand,
  buildTerminalEnv,
  loginShellPath,
  resetLoginShellPathCache,
  resolveLoginShell,
  shellCannotRun,
  shellName,
  TERMINAL_TYPE
} from './shell-environment'

describe('resolveLoginShell', () => {
  it('trusts SHELL on unix', () => {
    expect(resolveLoginShell('darwin', { SHELL: '/opt/homebrew/bin/fish' })).toBe('/opt/homebrew/bin/fish')
    expect(resolveLoginShell('linux', { SHELL: '/usr/bin/zsh' })).toBe('/usr/bin/zsh')
  })

  it('falls back per platform when SHELL is missing or empty', () => {
    expect(resolveLoginShell('darwin', {})).toBe('/bin/zsh')
    expect(resolveLoginShell('linux', { SHELL: '' })).toBe('/bin/bash')
  })

  it('prefers ComSpec on Windows and PowerShell when there is none', () => {
    expect(resolveLoginShell('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toBe(
      'C:\\Windows\\system32\\cmd.exe'
    )
    expect(resolveLoginShell('win32', { SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })
})

describe('buildShellCommand', () => {
  it('runs an explicit command through the shell', () => {
    // No profile: the PATH arrives in the environment, from loginShellPath.
    expect(buildShellCommand('/bin/zsh', 'claude --resume', 'darwin')).toEqual({
      file: '/bin/zsh',
      args: ['-c', 'claude --resume']
    })
  })

  it('starts a login shell when there is no command', () => {
    expect(buildShellCommand('/bin/bash', undefined, 'linux')).toEqual({ file: '/bin/bash', args: ['-l'] })
  })

  it('gives an unfamiliar shell no flags it might not accept', () => {
    expect(buildShellCommand('/usr/local/bin/nu', undefined, 'linux')).toEqual({ file: '/usr/local/bin/nu', args: [] })
  })

  it('uses cmd and PowerShell conventions on Windows', () => {
    // Windows argv is handed over pre-escaped; see tests/platform for the rules.
    expect(buildShellCommand('C:\\Windows\\system32\\cmd.exe', 'dir', 'win32')).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: '/d /s /c "dir"'
    })
    expect(buildShellCommand('C:\\pwsh.exe', 'Get-ChildItem', 'win32')).toEqual({
      file: 'C:\\pwsh.exe',
      args: '-NoLogo -Command Get-ChildItem'
    })
    expect(buildShellCommand('C:\\pwsh.exe', undefined, 'win32')).toEqual({
      file: 'C:\\pwsh.exe',
      args: '-NoLogo'
    })
  })
})

describe('buildTerminalEnv', () => {
  it('keeps the user PATH exactly as it was', () => {
    const env = buildTerminalEnv({ PATH: '/my/bin:/usr/bin', HOME: '/Users/x' })
    expect(env.PATH).toBe('/my/bin:/usr/bin')
    expect(env.HOME).toBe('/Users/x')
  })

  it('substitutes a PATH only when there is none', () => {
    expect(buildTerminalEnv({}, 'linux').PATH).toContain('/usr/bin')
    expect(buildTerminalEnv({}, 'darwin').PATH).toContain('/usr/bin')
    expect(buildTerminalEnv({}, 'win32').PATH).toContain('\\Windows')
    // And here, wherever here is, a pane is never handed an empty PATH.
    expect(buildTerminalEnv({}).PATH).not.toBe('')
  })

  it('declares the terminal it actually is', () => {
    const env = buildTerminalEnv({ TERM: 'dumb', COLORTERM: '' })
    expect(env.TERM).toBe(TERMINAL_TYPE)
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.TERM_PROGRAM).toBe('teamree')
  })

  it('strips what would confuse a child CLI', () => {
    const env = buildTerminalEnv({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect',
      npm_config_runtime: 'electron',
      npm_lifecycle_event: 'dev',
      VITE_SOMETHING: 'x',
      CI: 'true',
      COLUMNS: '9999',
      TERMCAP: 'stale',
      KEEP_ME: 'yes'
    })

    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env).not.toHaveProperty('NODE_OPTIONS')
    expect(env).not.toHaveProperty('npm_config_runtime')
    expect(env).not.toHaveProperty('npm_lifecycle_event')
    expect(env).not.toHaveProperty('VITE_SOMETHING')
    expect(env).not.toHaveProperty('CI')
    expect(env).not.toHaveProperty('COLUMNS')
    expect(env).not.toHaveProperty('TERMCAP')
    expect(env.KEEP_ME).toBe('yes')
  })

  // Wearing an agent session's child marker, Claude Code stops writing its
  // transcript, and the pane comes back with "No conversation found with session ID".
  it('strips the markers of whichever agent session started the app', () => {
    const env = buildTerminalEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000000',
      CLAUDE_CODE_HOST_SESSION_ID: '00000000-0000-4000-8000-000000000001',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/somebody-elses.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_PID: '4242',
      // A setting, not a marker: why these are named one at a time, not stripped by prefix.
      CLAUDE_CODE_USE_BEDROCK: '1'
    })

    expect(env).not.toHaveProperty('CLAUDECODE')
    expect(env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION')
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID')
    expect(env).not.toHaveProperty('CLAUDE_CODE_HOST_SESSION_ID')
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
    expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_SOCKET')
    expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_TOKEN')
    expect(env).not.toHaveProperty('CLAUDE_PID')
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  })

  it('drops undefined values rather than passing them through', () => {
    const env = buildTerminalEnv({ PATH: '/usr/bin', UNSET: undefined })
    expect(Object.keys(env)).not.toContain('UNSET')
  })

  it('prefers a PATH the caller resolved to the one this process inherited', () => {
    const env = buildTerminalEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/x' }, 'darwin', '/opt/homebrew/bin:/usr/bin')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
    expect(env.HOME).toBe('/Users/x')
    // An empty one is not a resolved PATH, and does not displace a real one.
    expect(buildTerminalEnv({ PATH: '/usr/bin' }, 'darwin', '').PATH).toBe('/usr/bin')
  })

  // `fg;bg` in ANSI numbers; vim, codex and friends read it to choose colours for the ground.
  it('tells programs the tone of the ground they print on', () => {
    expect(buildTerminalEnv({ PATH: '/usr/bin' }, 'darwin', undefined, 'light').COLORFGBG).toBe('0;15')
    expect(buildTerminalEnv({ PATH: '/usr/bin' }, 'darwin', undefined, 'dark').COLORFGBG).toBe('15;0')
  })

  it('drops the COLORFGBG of whatever terminal launched the app', () => {
    expect(buildTerminalEnv({ PATH: '/usr/bin', COLORFGBG: '15;0' }).COLORFGBG).toBeUndefined()
    expect(buildTerminalEnv({ PATH: '/usr/bin', COLORFGBG: '15;0' }, 'darwin', undefined, 'light').COLORFGBG).toBe(
      '0;15'
    )
  })
})

describe('loginShellPath', () => {
  const created: string[] = []
  const originalShell = process.env.SHELL

  beforeEach(() => {
    resetLoginShellPathCache()
  })

  afterEach(async () => {
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
    resetLoginShellPathCache()
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** There is no login shell to ask on Windows, so these run where there is. */
  const itPosix = process.platform === 'win32' ? it.skip : it

  /** Plays a POSIX login shell: a PATH of its own, optional profile noise, then the script it was handed. */
  const answersWith =
    (loginPath: string, noise = '') =>
    (_file: string, args: readonly string[]): string =>
      noise +
      execFileSync('/bin/sh', ['-c', args[args.length - 1] ?? ''], { env: { PATH: loginPath }, encoding: 'utf8' })

  itPosix('takes the PATH the user profile ended up with, asked for as a login shell', () => {
    let asked: readonly string[] = []
    const resolved = loginShellPath({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      run: (file, args) => {
        expect(file).toBe('/bin/zsh')
        asked = args
        return answersWith('/opt/homebrew/bin:/usr/bin')(file, args)
      }
    })

    expect(resolved).toBe('/opt/homebrew/bin:/usr/bin')
    // Login for ~/.zprofile, interactive for ~/.zshrc (where version managers put shims).
    expect(asked.slice(0, 3)).toEqual(['-l', '-i', '-c'])
  })

  itPosix('ignores whatever the profile printed before the answer', () => {
    const resolved = loginShellPath({
      platform: 'darwin',
      env: { SHELL: '/bin/bash' },
      run: answersWith('/opt/homebrew/bin:/usr/bin', 'Last login: yesterday\nnvm: v20.11.0 in use\n')
    })

    expect(resolved).toBe('/opt/homebrew/bin:/usr/bin')
  })

  itPosix('keeps the fallback when the answer is not a search path', () => {
    const zsh = { platform: 'darwin' as const, env: { SHELL: '/bin/zsh' } }

    // Nothing ran the probe, so nothing marked its answer.
    expect(loginShellPath({ ...zsh, run: () => 'zsh: command not found: printf' })).toBeUndefined()
    // Marked, and still not a search path: no absolute directory anywhere in it.
    expect(loginShellPath({ ...zsh, run: answersWith('relative/bin') })).toBeUndefined()
    // An empty PATH is an answer the user can do nothing with either.
    expect(loginShellPath({ ...zsh, run: answersWith('') })).toBeUndefined()
    // And a shell that could not be started at all.
    expect(loginShellPath({ ...zsh, run: () => null })).toBeUndefined()
  })

  itPosix('asks fish in its own dialect, where PATH is a list rather than a string', () => {
    let script = ''
    loginShellPath({
      platform: 'darwin',
      env: { SHELL: '/opt/homebrew/bin/fish' },
      run: (_file, args) => {
        script = args[args.length - 1] ?? ''
        return ''
      }
    })

    // In fish "$PATH" is the entries joined with spaces, which is not a PATH.
    expect(script).toContain('string join : $PATH')
  })

  it('does not ask a shell that may not understand the question', () => {
    let asked = false
    const resolved = loginShellPath({
      platform: 'linux',
      env: { SHELL: '/usr/local/bin/nu' },
      run: () => {
        asked = true
        return ''
      }
    })

    expect(resolved).toBeUndefined()
    expect(asked).toBe(false)
  })

  it('has no login shell to ask on Windows', () => {
    let asked = false
    const resolved = loginShellPath({
      platform: 'win32',
      env: { SHELL: '/bin/zsh' },
      run: () => {
        asked = true
        return ''
      }
    })

    expect(resolved).toBeUndefined()
    expect(asked).toBe(false)
  })

  itPosix('comes back with nothing rather than throwing when SHELL names nothing', () => {
    expect(loginShellPath({ platform: 'darwin', env: { SHELL: '/nowhere/at/all/zsh' } })).toBeUndefined()
  })

  itPosix('asks once and remembers, so a pane does not pay for a shell start', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-login-shell-'))
    created.push(dir)
    const runs = path.join(dir, 'runs')
    const shell = path.join(dir, 'zsh')
    await writeFile(
      shell,
      `#!/bin/sh\necho x >> '${runs}'\nPATH=/opt/homebrew/bin:/usr/bin\nexport PATH\nshift $(($# - 1)); eval "$1"\n`,
      'utf8'
    )
    await chmod(shell, 0o755)
    process.env.SHELL = shell

    expect(loginShellPath()).toBe('/opt/homebrew/bin:/usr/bin')
    expect(loginShellPath()).toBe('/opt/homebrew/bin:/usr/bin')

    // Twice asked, once run: a login shell is too expensive to start per pane.
    expect((await readFile(runs, 'utf8')).trim().split('\n')).toHaveLength(1)
  })
})

describe('shellName', () => {
  it('reduces a path to a bare lowercase name', () => {
    expect(shellName('/bin/zsh', 'darwin')).toBe('zsh')
    expect(shellName('C:\\Windows\\System32\\CMD.EXE', 'win32')).toBe('cmd')
  })
})

describe('shellCannotRun', () => {
  const created: string[] = []
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const scratch = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-shell-'))
    created.push(dir)
    return dir
  }

  /** The rule is POSIX exec's; on Windows node-pty answers instead. */
  const itPosix = process.platform === 'win32' ? it.skip : it

  it('leaves the question to node-pty on Windows', () => {
    expect(shellCannotRun('C:\\nothing\\here.exe', { Path: 'C:\\Windows' }, 'C:\\', 'win32')).toBe(false)
  })

  itPosix('accepts the shell this platform opens panes with', async () => {
    expect(shellCannotRun(resolveLoginShell(), process.env, process.cwd())).toBe(false)
  })

  itPosix('refuses a path with nothing at it', async () => {
    const dir = await scratch()
    expect(shellCannotRun(path.join(dir, 'not-a-shell'), {}, dir)).toBe(true)
  })

  itPosix('refuses a file nobody may execute, and the directory it sits in', async () => {
    const dir = await scratch()
    const readable = path.join(dir, 'readable')
    await writeFile(readable, '#!/bin/sh\n', 'utf8')
    await chmod(readable, 0o644)
    expect(shellCannotRun(readable, {}, dir)).toBe(true)
    // A directory answers yes to the execute bit and is still not a program.
    await mkdir(path.join(dir, 'bin'), { recursive: true })
    expect(shellCannotRun(path.join(dir, 'bin'), {}, dir)).toBe(true)
  })

  itPosix('searches PATH for a bare name, the way exec does', async () => {
    const dir = await scratch()
    const bin = path.join(dir, 'bin')
    await mkdir(bin, { recursive: true })
    const tool = path.join(bin, 'my-shell')
    await writeFile(tool, '#!/bin/sh\n', 'utf8')
    await chmod(tool, 0o755)

    expect(shellCannotRun('my-shell', { PATH: bin }, dir)).toBe(false)
    expect(shellCannotRun('my-shell', { PATH: '/nowhere' }, dir)).toBe(true)
    // No PATH at all is the same answer as a PATH without it in.
    expect(shellCannotRun('my-shell', {}, dir)).toBe(true)
  })
})
