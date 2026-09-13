import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildShellCommand,
  buildTerminalEnv,
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
    // Which PATH is a property of the platform asked about, not of the machine
    // the suite happens to be running on, so each one is named.
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

  it('drops undefined values rather than passing them through', () => {
    const env = buildTerminalEnv({ PATH: '/usr/bin', UNSET: undefined })
    expect(Object.keys(env)).not.toContain('UNSET')
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
