import type { CommandSpec } from '../command-spec.js'
import { readBoolean, readNumber, readString, requireString } from '../argv.js'
import { formatFields, formatTable } from '../output.js'
import { resolveWorktree } from '../selectors.js'

/** Terminals are addressed by id only: ids come straight from `terminal list`. */
const TERMINAL_ARG = { name: 'terminal', description: 'Terminal id from `teamree terminal list`.', required: true } as const

export const terminalCommands: readonly CommandSpec[] = [
  {
    path: ['terminal', 'list'],
    summary: 'List terminals, optionally for one worktree.',
    flags: [
      { name: 'worktree', kind: 'string', placeholder: '<worktree>', description: 'Restrict to one worktree (id, name, path, or branch).' }
    ],
    run: async (context) => {
      const selector = readString(context.flags, 'worktree')
      const worktreeId = selector === undefined ? undefined : (await resolveWorktree(context.client, selector)).id
      const terminals = await context.client.call('terminal.list', worktreeId === undefined ? {} : { worktreeId })
      return {
        data: terminals,
        text: formatTable(
          ['ID', 'WORKTREE', 'TITLE', 'SIZE', 'RUNNING', 'CWD'],
          terminals.map((terminal) => [
            terminal.id,
            terminal.worktreeId,
            terminal.title,
            `${terminal.cols}x${terminal.rows}`,
            terminal.running ? 'yes' : `no (exit ${terminal.exitCode ?? '?'})`,
            terminal.cwd
          ]),
          'No terminals. Create one with: teamree terminal create --worktree <id>'
        )
      }
    }
  },
  {
    path: ['terminal', 'create'],
    summary: 'Open a terminal in a worktree.',
    flags: [
      { name: 'worktree', kind: 'string', placeholder: '<worktree>', description: 'Worktree id, name, path, or branch.', required: true },
      { name: 'command', kind: 'string', placeholder: '<cmd>', description: 'Run this instead of an interactive shell.' },
      { name: 'shell', kind: 'string', placeholder: '<shell>', description: "Shell to spawn; defaults to the user's login shell." },
      { name: 'cwd', kind: 'string', placeholder: '<dir>', description: "Working directory; defaults to the worktree's checkout." },
      { name: 'cols', kind: 'number', placeholder: '<n>', description: 'Initial column count.' },
      { name: 'rows', kind: 'number', placeholder: '<n>', description: 'Initial row count.' }
    ],
    examples: ['teamree terminal create --worktree fix-login --command "npm test"'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, requireString(context.flags, 'worktree'))
      const command = readString(context.flags, 'command')
      const shell = readString(context.flags, 'shell')
      const cwd = readString(context.flags, 'cwd')
      const cols = readNumber(context.flags, 'cols')
      const rows = readNumber(context.flags, 'rows')
      const terminal = await context.client.call('terminal.create', {
        worktreeId: worktree.id,
        ...(command === undefined ? {} : { command }),
        ...(shell === undefined ? {} : { shell }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows })
      })
      return {
        data: terminal,
        text: formatFields([
          ['id', terminal.id],
          ['worktree', terminal.worktreeId],
          ['title', terminal.title],
          ['shell', terminal.shell],
          ['cwd', terminal.cwd],
          ['size', `${terminal.cols}x${terminal.rows}`]
        ])
      }
    }
  },
  {
    path: ['terminal', 'read'],
    summary: 'Print a terminal\'s scrollback snapshot.',
    details: 'Text mode writes the raw buffer to stdout so it can be read directly; --json wraps it instead.',
    args: [TERMINAL_ARG],
    flags: [
      { name: 'tail-bytes', kind: 'number', placeholder: '<n>', description: 'Return only the trailing N bytes.' }
    ],
    examples: ['teamree terminal read t_12 --tail-bytes 4000'],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const tailBytes = readNumber(context.flags, 'tail-bytes')
      const result = await context.client.call('terminal.read', {
        terminalId,
        ...(tailBytes === undefined ? {} : { tailBytes })
      })
      return { data: { terminalId, data: result.data, bytes: Buffer.byteLength(result.data) }, text: result.data }
    }
  },
  {
    path: ['terminal', 'send'],
    summary: 'Write text to a terminal.',
    details: 'The text is sent verbatim; --enter appends a carriage return, which is what a PTY expects for a keypress.',
    args: [TERMINAL_ARG],
    flags: [
      { name: 'text', kind: 'string', placeholder: '<text>', description: 'Exact bytes to write.', required: true },
      { name: 'enter', kind: 'boolean', description: 'Append a carriage return, submitting the line.' }
    ],
    examples: ['teamree terminal send t_12 --text "npm test" --enter'],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const data = requireString(context.flags, 'text') + (readBoolean(context.flags, 'enter') ? '\r' : '')
      await context.client.call('terminal.write', { terminalId, data })
      const bytes = Buffer.byteLength(data)
      return { data: { terminalId, bytes, enter: readBoolean(context.flags, 'enter') }, text: `sent ${bytes} bytes to ${terminalId}` }
    }
  },
  {
    path: ['terminal', 'split'],
    summary: 'Split a pane and open a terminal in the new half.',
    args: [TERMINAL_ARG],
    flags: [
      {
        name: 'direction',
        kind: 'string',
        placeholder: '<row|column>',
        description: 'Split axis: row places panes side by side, column stacks them.',
        choices: ['row', 'column'],
        required: true
      },
      { name: 'command', kind: 'string', placeholder: '<cmd>', description: 'Run this in the new pane instead of a shell.' }
    ],
    examples: ['teamree terminal split t_12 --direction column'],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const direction = requireString(context.flags, 'direction') as 'row' | 'column'
      const command = readString(context.flags, 'command')
      const result = await context.client.call('terminal.split', {
        terminalId,
        direction,
        ...(command === undefined ? {} : { command })
      })
      return {
        data: result,
        text: formatFields([
          ['id', result.terminal.id],
          ['split from', terminalId],
          ['direction', direction],
          ['worktree', result.terminal.worktreeId],
          ['cwd', result.terminal.cwd]
        ])
      }
    }
  },
  {
    path: ['terminal', 'close'],
    summary: 'Close a terminal and its pane.',
    args: [TERMINAL_ARG],
    run: async (context) => {
      const terminalId = context.args[0] as string
      await context.client.call('terminal.close', { terminalId })
      return { data: { closed: true, terminalId }, text: `closed terminal ${terminalId}` }
    }
  }
]
