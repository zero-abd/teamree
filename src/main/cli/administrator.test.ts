import { execFile } from 'node:child_process'
import { mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { administratorScript, appleScriptString, linkCommand, shellQuote } from './administrator'

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

/**
 * Reads an AppleScript string literal back, independently of the code that
 * wrote it. Asserting the escaped text looks a certain way only proves it
 * matches this test's idea of it; decoding proves the literal means the path.
 */
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
    // The proof is the shell's own reading of the command, not a string
    // comparison: `printf %s` writes exactly the one argument it was handed.
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

    // The shell half of the escaping, executed rather than asserted: whatever
    // `do shell script` would hand /bin/sh is what runs here.
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
