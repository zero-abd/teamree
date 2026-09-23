import { describe, expect, it } from 'vitest'
import {
  COMMANDS,
  commandGroups,
  findCommand,
  parseCommand,
  resolveCommand,
  scanCommandWords,
  usageName
} from './command-table.js'
import { commandName, type CommandSpec } from './command-spec.js'
import { helpDocument, renderCommandHelp, renderGroupHelp, renderRootHelp, usageLine } from './help.js'
import { UsageError } from './exit.js'

function spec(name: string): CommandSpec {
  const found = findCommand(name.split(' '))
  if (!found) throw new Error(`no command ${name}`)
  return found
}

const EXPECTED = [
  'status',
  'quit',
  'project list',
  'project add',
  'project linked',
  'project copied',
  'project setup',
  'project remove',
  'worktree list',
  'worktree create',
  'worktree remove',
  'worktree status',
  'worktree changes',
  'worktree diff',
  'worktree merges',
  'worktree log',
  'worktree commit',
  'worktree push',
  'worktree wait',
  'terminal list',
  'terminal create',
  'terminal read',
  'terminal send',
  'terminal split',
  'terminal relaunch',
  'terminal rename',
  'terminal close',
  'terminal wait',
  'terminal run',
  'worktree start-points',
  'worktree layout',
  'team status',
  'team members',
  'team join',
  'team publish',
  'team invite',
  'team accept',
  'team relay show',
  'team relay set',
  'team watch',
  'team type',
  'team panes',
  'team watchers',
  'team requests',
  'team allow',
  'team deny',
  'team revoke',
  'team mute',
  'team unmute',
  'team write-log',
  'agent list',
  'cli status',
  'cli install'
]

describe('the command table', () => {
  it('covers exactly the documented surface', () => {
    expect(COMMANDS.map(commandName).sort()).toEqual([...EXPECTED].sort())
  })

  it('groups the nouns', () => {
    expect(commandGroups()).toEqual(['project', 'worktree', 'terminal', 'team', 'agent', 'cli'])
  })

  it('resolves every command from its own words', () => {
    for (const name of EXPECTED) {
      const resolution = resolveCommand(name.split(' '))
      expect(resolution.kind).toBe('command')
      if (resolution.kind === 'command') expect(commandName(resolution.spec)).toBe(name)
    }
  })
})

describe('resolveCommand', () => {
  it('ignores global flags placed before the command', () => {
    const resolution = resolveCommand(['--json', 'worktree', 'list'])
    expect(resolution.kind).toBe('command')
    if (resolution.kind === 'command') {
      expect(commandName(resolution.spec)).toBe('worktree list')
      expect(resolution.rest).toEqual(['--json'])
    }
  })

  it('does not mistake a global flag value for a command word', () => {
    const resolution = resolveCommand(['--timeout', '500', 'status'])
    expect(resolution.kind).toBe('command')
    if (resolution.kind === 'command') expect(commandName(resolution.spec)).toBe('status')
    expect(scanCommandWords(['--timeout', '500', 'status']).map((entry) => entry.word)).toEqual(['status'])
    expect(scanCommandWords(['--timeout=500', 'status']).map((entry) => entry.word)).toEqual(['status'])
  })

  it('keeps command flags and positionals in rest', () => {
    const resolution = resolveCommand(['terminal', 'send', 't_1', '--text', 'ls', '--enter'])
    expect(resolution.kind).toBe('command')
    if (resolution.kind === 'command') expect(resolution.rest).toEqual(['t_1', '--text', 'ls', '--enter'])
  })

  it('reports an empty invocation', () => {
    expect(resolveCommand([]).kind).toBe('empty')
    expect(resolveCommand(['--json']).kind).toBe('empty')
  })

  it('reports a bare group', () => {
    expect(resolveCommand(['worktree'])).toEqual({ kind: 'group', group: 'worktree' })
  })

  it('reports an unknown command, including one under a known group', () => {
    expect(resolveCommand(['nope'])).toEqual({ kind: 'unknown', words: ['nope'] })
    expect(resolveCommand(['worktree', 'frobnicate'])).toEqual({ kind: 'unknown', words: ['worktree', 'frobnicate'] })
  })

  it('stops scanning at the -- terminator', () => {
    expect(resolveCommand(['--', 'status']).kind).toBe('empty')
  })
})

describe('parseCommand', () => {
  it('accepts a full terminal send', () => {
    const parsed = parseCommand(spec('terminal send'), ['t_1', '--text', 'npm test', '--enter'])
    expect(parsed.positionals).toEqual(['t_1'])
    expect(parsed.flags['text']).toBe('npm test')
    expect(parsed.flags['enter']).toBe(true)
  })

  it('accepts the selector flags of worktree create', () => {
    const parsed = parseCommand(spec('worktree create'), ['--project', 'api', '--name', 'fix', '--from', 'origin/main'])
    expect(parsed.flags).toMatchObject({ project: 'api', name: 'fix', from: 'origin/main' })
  })

  it('rejects a missing required flag', () => {
    expect(() => parseCommand(spec('worktree create'), ['--name', 'fix'])).toThrow(/--project is required/)
    expect(() => parseCommand(spec('terminal send'), ['t_1'])).toThrow(/--text is required/)
  })

  it('rejects a missing positional', () => {
    try {
      parseCommand(spec('worktree remove'), [])
      throw new Error('expected a usage error')
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      expect((error as UsageError).message).toMatch(/needs <worktree>/)
      expect((error as UsageError).exitCode).toBe(2)
    }
  })

  it('rejects extra positionals', () => {
    expect(() => parseCommand(spec('worktree remove'), ['a', 'b'])).toThrow(/takes 1 argument, got 2/)
    expect(() => parseCommand(spec('project list'), ['a'])).toThrow(/takes 0 arguments, got 1/)
  })

  it('rejects an invalid choice', () => {
    expect(() => parseCommand(spec('terminal split'), ['t_1', '--direction', 'diagonal'])).toThrow(/row, column/)
  })

  it('accepts global flags on every command', () => {
    for (const command of COMMANDS) {
      const args = (command.args ?? []).map((arg) => `x-${arg.name}`)
      const flags = (command.flags ?? [])
        .filter((flag) => flag.required)
        .flatMap((flag) =>
          flag.kind === 'boolean' ? [`--${flag.name}`] : [`--${flag.name}`, flag.choices?.[0] ?? 'v']
        )
      const parsed = parseCommand(command, [...args, ...flags, '--json', '--timeout', '100'])
      expect(parsed.flags['json']).toBe(true)
      expect(parsed.flags['timeout']).toBe(100)
    }
  })
})

describe('help rendering', () => {
  it('lists every command at the root', () => {
    const text = renderRootHelp()
    for (const name of EXPECTED) expect(text).toContain(name)
    expect(text).toContain('3')
    expect(text).toContain('no runtime running')
  })

  it('renders a group', () => {
    const text = renderGroupHelp('terminal')
    expect(text).toContain('terminal split')
    expect(text).not.toContain('project add')
  })

  it('renders a command with its flags, arguments and examples', () => {
    const text = renderCommandHelp(spec('worktree create'))
    expect(text).toContain('--project <project>')
    expect(text).toContain('(required)')
    expect(text).toContain('Examples:')
    expect(usageLine(spec('worktree create'))).toBe('teamree worktree create --project <project> --name <name> [flags]')
    expect(usageLine(spec('terminal close'))).toBe('teamree terminal close <terminal>')
  })

  it('describes the whole surface as data', () => {
    const document = helpDocument() as {
      commands: Array<{ name: string; flags: unknown[] }>
      exitCodes: Record<string, string>
    }
    expect(document.commands.map((command) => command.name).sort()).toEqual([...EXPECTED].sort())
    expect(document.exitCodes['3']).toBe('no runtime running')
  })

  it('scopes the data document to one command', () => {
    const document = helpDocument(['terminal', 'read']) as { commands: Array<{ name: string }> }
    expect(document.commands.map((command) => command.name)).toEqual(['terminal read'])
  })
})

describe('a variadic tail', () => {
  const spec = findCommand(['worktree', 'commit'])

  it('is how the commit command takes its paths', () => {
    expect(spec?.args?.[spec.args.length - 1]?.variadic).toBe(true)
  })

  it('accepts as many paths as it is given', () => {
    const parsed = parseCommand(spec as CommandSpec, ['fix-login', '-m', 'msg', '--', 'a.ts', 'b.ts', 'c.ts'])
    expect(parsed.positionals).toEqual(['fix-login', 'a.ts', 'b.ts', 'c.ts'])
  })

  it('still insists on the argument before it', () => {
    expect(() => parseCommand(spec as CommandSpec, ['-m', 'msg'])).toThrow(/needs <worktree>/)
  })

  it('reads as repeatable in the usage line', () => {
    expect(usageName({ name: 'path', required: false, variadic: true })).toBe('[<path>...]')
    expect(usageName({ name: 'worktree', required: true })).toBe('<worktree>')
    expect(usageName({ name: 'project', required: false })).toBe('[<project>]')
  })

  it('leaves a fixed-arity command refusing extra words', () => {
    const status = findCommand(['worktree', 'status'])
    expect(() => parseCommand(status as CommandSpec, ['one', 'two'])).toThrow(/takes 1 argument/)
  })
})
