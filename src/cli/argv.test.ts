import { describe, expect, it } from 'vitest'
import {
  flagKey,
  flagLabel,
  parseArgs,
  readBoolean,
  readNumber,
  readString,
  readStrings,
  requireString,
  type FlagSpec
} from './argv.js'
import { UsageError } from './exit.js'

const SPECS: FlagSpec[] = [
  { name: 'json', kind: 'boolean', alias: 'j', description: 'json' },
  { name: 'name', kind: 'string', description: 'name' },
  { name: 'tail-bytes', kind: 'number', description: 'tail' },
  { name: 'direction', kind: 'string', choices: ['row', 'column'], description: 'direction' },
  { name: 'project', kind: 'string', required: true, description: 'project' }
]

const OPTIONAL = SPECS.filter((spec) => !spec.required)

describe('flagKey', () => {
  it('camel-cases kebab names', () => {
    expect(flagKey('tail-bytes')).toBe('tailBytes')
    expect(flagKey('delete-branch')).toBe('deleteBranch')
    expect(flagKey('json')).toBe('json')
  })
})

describe('flagLabel', () => {
  it('shows the alias and placeholder', () => {
    expect(flagLabel(SPECS[0] as FlagSpec)).toBe('-j, --json')
    expect(flagLabel({ name: 'from', kind: 'string', placeholder: '<ref>', description: '' })).toBe('--from <ref>')
    expect(flagLabel({ name: 'from', kind: 'string', description: '' })).toBe('--from <string>')
  })
})

describe('parseArgs', () => {
  it('reads separated and inline values', () => {
    expect(parseArgs(['--name', 'fix-login'], OPTIONAL).flags['name']).toBe('fix-login')
    expect(parseArgs(['--name=fix-login'], OPTIONAL).flags['name']).toBe('fix-login')
  })

  it('accepts an empty inline value', () => {
    expect(parseArgs(['--name='], OPTIONAL).flags['name']).toBe('')
  })

  it('accepts a value that starts with a dash when written inline', () => {
    expect(parseArgs(['--name=--enter'], OPTIONAL).flags['name']).toBe('--enter')
  })

  it('sets switches and their negation', () => {
    expect(parseArgs(['--json'], OPTIONAL).flags['json']).toBe(true)
    expect(parseArgs(['-j'], OPTIONAL).flags['json']).toBe(true)
    expect(parseArgs(['--no-json'], OPTIONAL).flags['json']).toBe(false)
    expect(parseArgs([], OPTIONAL).flags['json']).toBeUndefined()
  })

  it('rejects a value on a switch', () => {
    expect(() => parseArgs(['--json=yes'], OPTIONAL)).toThrow(UsageError)
  })

  it('camel-cases keys', () => {
    expect(parseArgs(['--tail-bytes', '512'], OPTIONAL).flags['tailBytes']).toBe(512)
  })

  it('rejects non-integer numbers', () => {
    expect(() => parseArgs(['--tail-bytes', '12.5'], OPTIONAL)).toThrow(/whole number/)
    expect(() => parseArgs(['--tail-bytes', 'lots'], OPTIONAL)).toThrow(/whole number/)
  })

  it('enforces choices', () => {
    expect(parseArgs(['--direction', 'row'], OPTIONAL).flags['direction']).toBe('row')
    expect(() => parseArgs(['--direction', 'diagonal'], OPTIONAL)).toThrow(/row, column/)
  })

  it('rejects unknown flags and lists the known ones', () => {
    expect(() => parseArgs(['--nope'], OPTIONAL)).toThrow(/Unknown flag --nope/)
    try {
      parseArgs(['--nope'], OPTIONAL)
    } catch (error) {
      expect((error as UsageError).hint).toContain('--direction')
      expect((error as UsageError).exitCode).toBe(2)
    }
  })

  it('rejects a value-taking flag with nothing after it', () => {
    expect(() => parseArgs(['--name'], OPTIONAL)).toThrow(/--name needs a value/)
  })

  it('enforces required flags', () => {
    expect(() => parseArgs([], SPECS)).toThrow(/--project is required/)
    expect(parseArgs(['--project', 'api'], SPECS).flags['project']).toBe('api')
  })

  it('collects positionals and honours the -- terminator', () => {
    const parsed = parseArgs(['t_1', '--name', 'x', 't_2', '--', '--name', '-j'], OPTIONAL)
    expect(parsed.positionals).toEqual(['t_1', 't_2', '--name', '-j'])
    expect(parsed.flags['name']).toBe('x')
  })

  it('treats a bare dash as a positional', () => {
    expect(parseArgs(['-'], OPTIONAL).positionals).toEqual(['-'])
  })

  it('lets the last occurrence win', () => {
    expect(parseArgs(['--name', 'a', '--name', 'b'], OPTIONAL).flags['name']).toBe('b')
  })

  it('applies defaults', () => {
    const specs: FlagSpec[] = [{ name: 'limit', kind: 'number', description: '', default: 10 }]
    expect(parseArgs([], specs).flags['limit']).toBe(10)
    expect(parseArgs(['--limit', '3'], specs).flags['limit']).toBe(3)
  })
})

describe('flag readers', () => {
  const { flags } = parseArgs(['--name', 'x', '--tail-bytes', '9', '--json'], OPTIONAL)

  it('read typed values', () => {
    expect(readString(flags, 'name')).toBe('x')
    expect(readNumber(flags, 'tail-bytes')).toBe(9)
    expect(readBoolean(flags, 'json')).toBe(true)
    expect(readBoolean(flags, 'direction')).toBe(false)
    expect(readString(flags, 'tail-bytes')).toBeUndefined()
  })

  it('requireString throws a usage error when absent', () => {
    expect(() => requireString(flags, 'direction')).toThrow(UsageError)
  })
})

// A flag somebody means to repeat has to keep every value: last-one-wins would
// quietly turn three agents into one.
describe('repeatable flags', () => {
  const specs: FlagSpec[] = [{ name: 'agent', kind: 'string', repeatable: true, description: 'agent' }]

  it('keeps every value, in the order they were typed', () => {
    const parsed = parseArgs(['--agent', 'claude', '--agent=codex', '--agent', 'claude'], specs)
    expect(readStrings(parsed.flags, 'agent')).toEqual(['claude', 'codex', 'claude'])
  })

  it('reads one value as a list of one, and none as an empty list', () => {
    expect(readStrings(parseArgs(['--agent', 'claude'], specs).flags, 'agent')).toEqual(['claude'])
    expect(readStrings(parseArgs([], specs).flags, 'agent')).toEqual([])
  })

  it('leaves a flag that is not repeatable alone', () => {
    const parsed = parseArgs(['--name', 'one', '--name', 'two'], OPTIONAL)
    expect(readString(parsed.flags, 'name')).toBe('two')
  })
})
