import { execFile } from 'node:child_process'
import { mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import {
  administratorScript,
  appleScriptString,
  createAdministratorRunner,
  linkCommand,
  shellQuote,
  type ExecFile
} from './administrator'

const run = promisify(execFile)

/** Paths that break naive quoting. Every one of them is a legal macOS path. */
const AWKWARD = [
  'teamree copy.app',
  'say "hello"',
  "o'brien",
  'back\\slash',
  '$PATH `whoami`',
  'both " and \' together'
]

/** Reads an AppleScript string literal back, independently of the code that wrote it. */
function decodeAppleScriptString(literal: string): string {
  expect(literal.startsWith('"') && literal.endsWith('"')).toBe(true)
  const body = literal.slice(1, -1)
  let out = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (char !== '\\') {
      // A bare quote inside the body would have ended the literal.
      expect(char).not.toBe('"')
      out += char
      continue
    }
    index += 1
    const escaped = body[index] as string
    if (escaped === 'n') out += '\n'
    else if (escaped === 'r') out += '\r'
    else if (escaped === 't') out += '\t'
    else {
      expect(['\\', '"']).toContain(escaped)
      out += escaped
    }
  }
  return out
}

let scratch: string | null = null

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = null
})

describe('shell quoting', () => {
  it.each(AWKWARD)('survives a round trip through /bin/sh: %s', async (awkward) => {
    scratch = await mkdtemp(join(tmpdir(), 'tmr-quote-'))
    const source = join(scratch, awkward)
    await writeFile(source, 'cli')
    // The shell's own reading, not a string comparison.
    const { stdout } = await run('/bin/sh', ['-c', `printf %s ${shellQuote(source)}`])
    expect(stdout).toBe(source)
  })

  it('wraps in single quotes and breaks out only for a single quote', () => {
    expect(shellQuote('/usr/local/bin/teamree')).toBe(`'/usr/local/bin/teamree'`)
    expect(shellQuote("o'brien")).toBe(`'o'\\''brien'`)
  })
})

describe('AppleScript quoting', () => {
  it.each([...AWKWARD, 'line\nbreak', 'tab\there', 'carriage\rreturn'])('round-trips %j', (awkward) => {
    expect(decodeAppleScriptString(appleScriptString(awkward))).toBe(awkward)
  })

  it('never leaves a newline in the literal, which AppleScript cannot parse', () => {
    expect(appleScriptString('line\nbreak')).toBe('"line\\nbreak"')
  })
})

describe('the link command', () => {
  const destination = '/usr/local/bin/teamree'

  it('makes the directory and replaces whatever link is there', () => {
    const command = linkCommand('/Applications/teamree.app/Contents/Resources/cli/teamree', destination)
    expect(command).toBe(
      `/bin/mkdir -p '/usr/local/bin' && ` +
        `/bin/ln -sfn '/Applications/teamree.app/Contents/Resources/cli/teamree' '/usr/local/bin/teamree'`
    )
  })

  it('links an app whose path has a space and a double quote in it', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'tmr-link-'))
    const source = join(scratch, 'my "teamree" copy.app', 'Contents', 'Resources', 'cli')
    await run('/bin/mkdir', ['-p', source])
    await writeFile(join(source, 'teamree'), 'cli')
    const link = join(scratch, 'bin', 'teamree')

    // The shell half, executed rather than asserted.
    await run('/bin/sh', ['-c', linkCommand(join(source, 'teamree'), link)])

    expect(await readlink(link)).toBe(join(source, 'teamree'))
  })

  it('carries the awkward path through both layers of quoting intact', () => {
    const source = '/Users/ann/My "teamree" copy.app/Contents/Resources/cli/teamree'
    const script = administratorScript(linkCommand(source, '/usr/local/bin/teamree'))
    expect(script.startsWith('do shell script "')).toBe(true)
    expect(script.endsWith('" with administrator privileges')).toBe(true)

    const command = decodeAppleScriptString(
      script.slice('do shell script '.length, -' with administrator privileges'.length)
    )
    expect(command).toBe(`/bin/mkdir -p '/usr/local/bin' && /bin/ln -sfn '${source}' '/usr/local/bin/teamree'`)
  })
})

describe('running it as an administrator', () => {
  /** Records what would have been spawned, and answers as a finished process. */
  function stub(answer: Parameters<Parameters<ExecFile>[2]>): {
    exec: ExecFile
    spawned: [string, readonly string[]][]
  } {
    const spawned: [string, readonly string[]][] = []
    return {
      spawned,
      exec: (file, args, callback) => {
        spawned.push([file, args])
        callback(...answer)
      }
    }
  }

  /** The real child_process, with the file swapped for one this machine has; the failure is not invented. */
  function failing(stderr: string, status = 1): ExecFile {
    return (_file, _args, callback) => {
      execFile('/bin/sh', ['-c', `printf %s ${shellQuote(stderr)} >&2; exit ${status}`], callback)
    }
  }

  it('hands osascript one script as one argument, never through a shell', async () => {
    const { exec, spawned } = stub([null, '', ''])
    const command = linkCommand(
      '/Volumes/my "teamree" copy.app/Contents/Resources/cli/teamree',
      '/usr/local/bin/teamree'
    )

    await createAdministratorRunner(exec)(command)

    expect(spawned).toHaveLength(1)
    const [file, args] = spawned[0]!
    expect(file).toBe('/usr/bin/osascript')
    expect(args).toEqual(['-e', administratorScript(command)])
    // Decoded back, so the proof is what osascript would read.
    const literal = args[1]!.slice('do shell script '.length, -' with administrator privileges'.length)
    expect(decodeAppleScriptString(literal)).toBe(command)
  })

  it('reads a cancelled password dialog as a decision rather than a fault', async () => {
    // That Cancel makes osascript say -128 is the one thing only a Mac can show.
    const runner = createAdministratorRunner(failing('execution error: User canceled. (-128)'))

    await expect(runner('/bin/ln -sfn a b')).rejects.toThrow(
      'The administrator password was not given, so nothing was changed.'
    )
    await expect(runner('/bin/ln -sfn a b')).rejects.toMatchObject({ code: ErrorCode.Conflict })
  })

  it('passes on any other refusal with what the system said', async () => {
    const runner = createAdministratorRunner(failing('execution error: Not authorised. (-1743)'))

    await expect(runner('/bin/ln -sfn a b')).rejects.toThrow(/macOS refused/)
    await expect(runner('/bin/ln -sfn a b')).rejects.toThrow(/-1743/)
  })

  it('has the failure itself to report when the system said nothing', async () => {
    const runner = createAdministratorRunner(failing('', 7))

    // Never an empty sentence ending in a colon.
    await expect(runner('/bin/ln -sfn a b')).rejects.toThrow(/macOS refused to run the command as an administrator: \S/)
  })
})
