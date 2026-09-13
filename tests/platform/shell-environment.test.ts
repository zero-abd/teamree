// How a pane is launched on each platform: which shell, which command line,
// which environment. Everything here is pure, so the Windows rules are asserted
// on any machine; the last block checks the running platform's own answers.

import { describe, expect, it } from 'vitest'
import {
  buildShellCommand,
  buildTerminalEnv,
  encodeWindowsCommandLine,
  cmdCommandLine,
  quoteWindowsArgument,
  resolveLoginShell,
  shellFamily,
  shellName
} from '../../src/main/terminals/shell-environment'

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

describe('shellName', () => {
  it('reads a name out of either separator and drops the extension', () => {
    expect(shellName(CMD, 'win32')).toBe('cmd')
    expect(shellName('C:/Program Files/Git/usr/bin/sh.exe', 'win32')).toBe('sh')
    expect(shellName('C:\\tools\\shell.CMD', 'win32')).toBe('shell')
    expect(shellName('/bin/zsh', 'darwin')).toBe('zsh')
    expect(shellName('/usr/bin/fish', 'linux')).toBe('fish')
  })

  it('treats a backslash as an ordinary character off Windows, where it is one', () => {
    expect(shellName('/bin/we\\ird', 'linux')).toBe('we\\ird')
  })
})

describe('shellFamily', () => {
  it('classifies the three Windows dialects', () => {
    expect(shellFamily(CMD, 'win32')).toBe('cmd')
    expect(shellFamily(POWERSHELL, 'win32')).toBe('powershell')
    expect(shellFamily(PWSH, 'win32')).toBe('powershell')
    expect(shellFamily(GIT_BASH, 'win32')).toBe('posix')
  })

  it('calls everything off Windows POSIX', () => {
    expect(shellFamily('/bin/zsh', 'darwin')).toBe('posix')
    expect(shellFamily('/bin/bash', 'linux')).toBe('posix')
  })
})

describe('quoteWindowsArgument', () => {
  // CommandLineToArgvW: a backslash run only doubles in front of a quote or at
  // the end of a quoted argument, and is literal everywhere else.
  const cases: ReadonlyArray<[string, string]> = [
    ['simple', 'simple'],
    ['has space', '"has space"'],
    ['', '""'],
    ['say "hi"', '"say \\"hi\\""'],
    ['C:\\path\\to\\thing', 'C:\\path\\to\\thing'],
    ['C:\\path with space\\', '"C:\\path with space\\\\"'],
    ['ends\\with\\backslash\\', 'ends\\with\\backslash\\'],
    ['a\\\\"b', '"a\\\\\\\\\\"b"'],
    ['tab\there', '"tab\there"']
  ]

  for (const [input, expected] of cases) {
    it(`encodes ${JSON.stringify(input)}`, () => {
      expect(quoteWindowsArgument(input)).toBe(expected)
    })
  }

  it('round-trips through the documented parser', () => {
    for (const argv of [
      ['a b', 'c"d', 'e\\', '', 'f\\\\g'],
      ['--flag', 'value with "quotes" and \\slashes\\']
    ]) {
      expect(parseWindowsCommandLine(encodeWindowsCommandLine(argv))).toEqual(argv)
    }
  })

  // Hand-picked cases only prove the cases somebody thought of, and this
  // encoder cannot be exercised against a real ConPTY from here. Enumerating
  // the alphabet that actually drives the rules — backslash, quote, separator,
  // ordinary character — covers the whole state machine instead of a sample of
  // it, which is the strongest claim available without a Windows machine.
  const ALPHABET = ['\\', '"', ' ', 'a'] as const

  function stringsUpTo(length: number): string[] {
    let all = ['']
    let frontier = ['']
    for (let step = 0; step < length; step += 1) {
      frontier = frontier.flatMap((prefix) => ALPHABET.map((character) => prefix + character))
      all = all.concat(frontier)
    }
    return all
  }

  it('round-trips every argument up to four characters of the alphabet that drives the rules', () => {
    const inputs = stringsUpTo(4)
    expect(inputs.length).toBe(341)
    for (const input of inputs) {
      const parsed = parseWindowsCommandLine(encodeWindowsCommandLine([input]))
      expect(parsed, `single argument ${JSON.stringify(input)}`).toEqual([input])
    }
  })

  // Separately, because an argument that encodes correctly on its own can still
  // merge with its neighbour: the boundary is where a trailing backslash run or
  // an unbalanced quote does its damage.
  it('keeps neighbouring arguments apart for every pair up to two characters', () => {
    const inputs = stringsUpTo(2)
    expect(inputs.length).toBe(21)
    for (const first of inputs) {
      for (const second of inputs) {
        const argv = [first, second]
        const parsed = parseWindowsCommandLine(encodeWindowsCommandLine(argv))
        expect(parsed, `pair ${JSON.stringify(argv)}`).toEqual(argv)
      }
    }
  })
})

describe('buildShellCommand on Windows', () => {
  it('hands cmd.exe a command line it parses itself', () => {
    // /s makes cmd strip exactly the outer quotes and take the rest verbatim,
    // which is the only form that survives a command containing its own quotes.
    expect(buildShellCommand(CMD, 'git commit -m "wip"', 'win32')).toEqual({
      file: CMD,
      args: '/d /s /c "git commit -m "wip""'
    })
    expect(cmdCommandLine('echo hi')).toBe('/d /s /c "echo hi"')
  })

  it('starts cmd.exe interactive with no arguments at all', () => {
    expect(buildShellCommand(CMD, undefined, 'win32')).toEqual({ file: CMD, args: '' })
  })

  // cmd.exe is a second parser, with nothing in common with CommandLineToArgvW,
  // and the commands most likely to break it are the ones carrying their own
  // quotes. Checked against cmd's documented /S rule rather than a fixed string,
  // so the assertion is about what cmd would run, not about how it was spelled.
  it('survives a command that carries its own quotes, whatever it contains', () => {
    for (const command of [
      'echo hi',
      'git commit -m "wip"',
      '"C:\\Program Files\\Git\\bin\\git.exe" status',
      'echo "a & b" && echo done',
      'echo ^caret% and "unbalanced'
    ]) {
      const { args } = buildShellCommand(CMD, command, 'win32')
      expect(commandCmdWouldRun(args as string), JSON.stringify(command)).toBe(command)
    }
  })

  it('quotes a PowerShell command by the CommandLineToArgvW rules', () => {
    const { args } = buildShellCommand(PWSH, 'Write-Output "a b"', 'win32')
    expect(args).toBe('-NoLogo -Command "Write-Output \\"a b\\""')
    expect(parseWindowsCommandLine(args as string)).toEqual(['-NoLogo', '-Command', 'Write-Output "a b"'])
  })

  // The defect: every Windows shell that was not cmd got PowerShell's flags, so
  // a Git for Windows shell was launched as `bash.exe -NoLogo` and the pane died
  // on a usage error before the user saw a prompt.
  it('gives a Git for Windows shell the POSIX flags it understands', () => {
    expect(buildShellCommand(GIT_BASH, undefined, 'win32')).toEqual({ file: GIT_BASH, args: '-l' })
    expect(buildShellCommand(GIT_BASH, 'npm test', 'win32')).toEqual({ file: GIT_BASH, args: '-c "npm test"' })
    expect(parseWindowsCommandLine('-c "npm test"')).toEqual(['-c', 'npm test'])
  })
})

describe('buildShellCommand on unix', () => {
  it('keeps argv an array, where there is no command line to escape', () => {
    expect(buildShellCommand('/bin/zsh', 'claude', 'darwin')).toEqual({ file: '/bin/zsh', args: ['-c', 'claude'] })
    expect(buildShellCommand('/bin/bash', undefined, 'linux')).toEqual({ file: '/bin/bash', args: ['-l'] })
    expect(buildShellCommand('/usr/bin/nu', undefined, 'linux')).toEqual({ file: '/usr/bin/nu', args: [] })
  })

  it('passes a command through without quoting it, because there is no re-parse', () => {
    const { args } = buildShellCommand('/bin/sh', 'echo "a b" && ls', 'linux')
    expect(args).toEqual(['-c', 'echo "a b" && ls'])
  })
})

describe('resolveLoginShell', () => {
  it('prefers ComSpec on Windows and accepts either spelling of it', () => {
    expect(resolveLoginShell('win32', { ComSpec: CMD })).toBe(CMD)
    expect(resolveLoginShell('win32', { COMSPEC: CMD })).toBe(CMD)
  })

  it('falls back to PowerShell under SystemRoot when ComSpec is absent', () => {
    expect(resolveLoginShell('win32', { SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    expect(resolveLoginShell('win32', {})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('uses SHELL on unix and a per-platform default without it', () => {
    expect(resolveLoginShell('linux', { SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish')
    expect(resolveLoginShell('darwin', {})).toBe('/bin/zsh')
    expect(resolveLoginShell('linux', {})).toBe('/bin/bash')
    expect(resolveLoginShell('linux', { SHELL: '' })).toBe('/bin/bash')
  })
})

describe('buildTerminalEnv', () => {
  // The defect: the fallback consulted the running platform rather than the one
  // the session was being built for, so the platform argument threaded through
  // PtySession stopped mattering here.
  it('substitutes the right PATH for the platform it is asked about', () => {
    expect(buildTerminalEnv({}, 'win32').PATH).toBe('C:\\Windows\\system32;C:\\Windows')
    expect(buildTerminalEnv({}, 'darwin').PATH).toContain('/usr/bin')
    expect(buildTerminalEnv({}, 'linux').PATH).toContain('/usr/bin')
  })

  it('leaves a Windows Path alone rather than adding a second spelling of it', () => {
    const env = buildTerminalEnv({ Path: 'C:\\tools;C:\\Windows' }, 'win32')
    expect(env.Path).toBe('C:\\tools;C:\\Windows')
    expect(env.PATH).toBeUndefined()
  })

  it('keeps a unix PATH exactly as it was', () => {
    expect(buildTerminalEnv({ PATH: '/my/bin' }, 'linux').PATH).toBe('/my/bin')
  })

  it('strips what would confuse a child on any platform', () => {
    const env = buildTerminalEnv(
      {
        PATH: '/usr/bin',
        NODE_OPTIONS: '--inspect',
        ELECTRON_RUN_AS_NODE: '1',
        npm_config_target: '38.0.0',
        CI: 'true',
        HOME: '/Users/x'
      },
      'darwin'
    )
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.npm_config_target).toBeUndefined()
    expect(env.CI).toBeUndefined()
    expect(env.HOME).toBe('/Users/x')
  })

  it('declares the same terminal identity on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const env = buildTerminalEnv({ TERM: 'dumb' }, platform)
      expect(env.TERM).toBe('xterm-256color')
      expect(env.TERM_PROGRAM).toBe('teamree')
      expect(env.COLORTERM).toBe('truecolor')
    }
  })
})

describe('the running platform', () => {
  it('builds a shell command this machine could actually execute', () => {
    const shell = resolveLoginShell()
    const { file, args } = buildShellCommand(shell, undefined)
    expect(file).toBe(shell)
    expect(typeof args === 'string' ? process.platform === 'win32' : Array.isArray(args)).toBe(true)
  })
})

/**
 * What cmd.exe would actually run, given the tail teamree hands it. cmd's
 * documented `/S` rule is the whole algorithm: strip the first and the last
 * quote after `/C`, and take everything else verbatim.
 */
function commandCmdWouldRun(tail: string): string {
  const marker = '/c '
  const at = tail.indexOf(marker)
  if (at === -1) throw new Error(`no /c in ${JSON.stringify(tail)}`)
  const rest = tail.slice(at + marker.length)
  const first = rest.indexOf('"')
  const last = rest.lastIndexOf('"')
  if (first === -1 || first === last) return rest
  return rest.slice(0, first) + rest.slice(first + 1, last) + rest.slice(last + 1)
}

/**
 * The CommandLineToArgvW algorithm, used only to check the encoder against the
 * parser it is written for. Takes an argument tail, not a full command line.
 */
function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let started = false
  let inQuotes = false
  let backslashes = 0

  const takeBackslashes = (): number => {
    const pending = backslashes
    backslashes = 0
    return pending
  }

  for (const character of commandLine) {
    if (character === '\\') {
      backslashes += 1
      started = true
      continue
    }
    if (character === '"') {
      const pending = takeBackslashes()
      current += '\\'.repeat(Math.floor(pending / 2))
      if (pending % 2 === 1) current += '"'
      else inQuotes = !inQuotes
      started = true
      continue
    }
    current += '\\'.repeat(takeBackslashes())
    if (!inQuotes && (character === ' ' || character === '\t')) {
      if (started) args.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }

  current += '\\'.repeat(takeBackslashes())
  if (started) args.push(current)
  return args
}
