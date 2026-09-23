import type { Terminal, Worktree } from '../../shared/entities.js'
import type { CommandSpec } from '../command-spec.js'
import { readBoolean, readNumber, readString, requireString, type ParsedFlags } from '../argv.js'
import { UsageError } from '../exit.js'
import { formatFields, formatTable } from '../output.js'
import { plainText } from '../plainText.js'
import { resolveWorktree, selectWorktree } from '../selectors.js'
import { DEFAULT_QUIET_MS, DEFAULT_WAIT_TIMEOUT_MS, waitForTerminal } from '../waiting.js'

/** Terminals are addressed by id only: ids come straight from `terminal list`. */
const TERMINAL_ARG = {
  name: 'terminal',
  description: 'Terminal id from `teamree terminal list`.',
  required: true
} as const

/**
 * The listing, with the worktree column reading as a name (the id when the
 * worktree has gone between the two calls). Pure and exported so it is tested without a runtime.
 */
export function terminalTable(terminals: readonly Terminal[], worktrees: readonly Worktree[]): string {
  const names = new Map(worktrees.map((worktree) => [worktree.id, worktree.name]))
  return formatTable(
    // NAME before TITLE: a strip of panes all titled `claude` is what this column tells apart.
    ['ID', 'WORKTREE', 'NAME', 'TITLE', 'SIZE', 'RUNNING', 'CWD'],
    terminals.map((terminal) => [
      terminal.id,
      names.get(terminal.worktreeId) ?? terminal.worktreeId,
      terminal.label ?? '-',
      terminal.title,
      `${terminal.cols}x${terminal.rows}`,
      terminal.running ? 'yes' : `no (exit ${terminal.exitCode ?? '?'})`,
      terminal.cwd
    ]),
    'No terminals. Create one with: teamree terminal create <worktree>'
  )
}

export const terminalCommands: readonly CommandSpec[] = [
  {
    path: ['terminal', 'list'],
    summary: 'List terminals, optionally for one worktree.',
    flags: [
      {
        name: 'worktree',
        kind: 'string',
        placeholder: '<worktree>',
        description: 'Restrict to one worktree (id, name, path, or branch).'
      }
    ],
    run: async (context) => {
      const selector = readString(context.flags, 'worktree')
      // Read whether or not one was named: the rows name the worktree column.
      const worktrees = await context.client.call('worktree.list', {})
      const worktreeId = selector === undefined ? undefined : selectWorktree(worktrees, selector).id
      const terminals = await context.client.call('terminal.list', worktreeId === undefined ? {} : { worktreeId })
      return { data: terminals, text: terminalTable(terminals, worktrees) }
    }
  },
  {
    path: ['terminal', 'create'],
    summary: 'Open a terminal in a worktree.',
    args: [{ name: 'worktree', description: 'Worktree id, name, path, or branch.', required: false }],
    flags: [
      {
        name: 'worktree',
        kind: 'string',
        placeholder: '<worktree>',
        description: 'Same thing as the positional.'
      },
      {
        name: 'command',
        kind: 'string',
        placeholder: '<cmd>',
        description: 'Run this instead of an interactive shell.'
      },
      {
        name: 'shell',
        kind: 'string',
        placeholder: '<shell>',
        description: "Shell to spawn; defaults to the user's login shell."
      },
      {
        name: 'cwd',
        kind: 'string',
        placeholder: '<dir>',
        description: "Working directory; defaults to the worktree's checkout."
      },
      { name: 'cols', kind: 'number', placeholder: '<n>', description: 'Initial column count.' },
      { name: 'rows', kind: 'number', placeholder: '<n>', description: 'Initial row count.' }
    ],
    examples: ['teamree terminal create fix-login --command "npm test"'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, worktreeSelector(context.args[0], context.flags))
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
    summary: "Print a terminal's scrollback snapshot.",
    details:
      'Text mode writes the raw buffer to stdout, escape sequences and all, unless --plain is given.\n\n' +
      '--json always carries the raw buffer in `data`, so a caller writing the bytes back gets the bytes; ' +
      'with --plain the stripped text rides alongside it in `plain`.',
    args: [TERMINAL_ARG],
    flags: [
      { name: 'tail-bytes', kind: 'number', placeholder: '<n>', description: 'Return only the trailing N bytes.' },
      {
        name: 'plain',
        kind: 'boolean',
        description: 'Strip escape sequences and replay the line edits: what the screen showed.'
      }
    ],
    examples: ['teamree terminal read t_12 --tail-bytes 4000', 'teamree terminal read t_12 --plain'],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const tailBytes = readNumber(context.flags, 'tail-bytes')
      const result = await context.client.call('terminal.read', {
        terminalId,
        ...(tailBytes === undefined ? {} : { tailBytes })
      })
      // The raw buffer stays in `data` whatever was asked for: a caller writing bytes back needs the bytes.
      const stripped = readBoolean(context.flags, 'plain') ? plainText(result.data) : undefined
      return {
        data: {
          terminalId,
          data: result.data,
          bytes: Buffer.byteLength(result.data),
          ...(stripped === undefined ? {} : { plain: stripped })
        },
        text: stripped ?? result.data
      }
    }
  },
  {
    path: ['terminal', 'send'],
    summary: 'Write text to a terminal.',
    details: 'The text is sent verbatim; --enter is the only thing that appends a carriage return.',
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
      return {
        data: { terminalId, bytes, enter: readBoolean(context.flags, 'enter') },
        text: `sent ${bytes} bytes to ${terminalId}`
      }
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
      {
        name: 'command',
        kind: 'string',
        placeholder: '<cmd>',
        description: 'Run this in the new pane instead of a shell.'
      }
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
    path: ['terminal', 'relaunch'],
    summary: 'Run an exited pane again, in place.',
    details:
      'The pane keeps its id, its directory and its place in the split tree, and what it printed stays above ' +
      'the line where the new run starts.\n\n' +
      'An agent pane starts the agent over under a fresh session id rather than resuming the old ' +
      'conversation: whether there is one worth coming back to is a question answered at startup, and this ' +
      'is for the pane that has already ended. Anything else comes back as a shell in the same directory.\n\n' +
      'Refused while the pane is still running.',
    args: [TERMINAL_ARG],
    examples: ['teamree terminal relaunch t_12'],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const terminal = await context.client.call('terminal.relaunch', { terminalId })
      return {
        data: terminal,
        text: formatFields([
          ['id', terminal.id],
          ['title', terminal.title],
          ['agent', terminal.agent ?? '-'],
          ['cwd', terminal.cwd],
          ['running', terminal.running ? 'yes' : 'no']
        ])
      }
    }
  },
  {
    path: ['terminal', 'rename'],
    summary: 'Name a terminal, or clear the name.',
    details:
      'The name is what the sidebar and the tab strip call the pane, in place of the program it runs. ' +
      "It survives a restart. Omit --name to go back to the program's own name.",
    args: [TERMINAL_ARG],
    flags: [{ name: 'name', kind: 'string', placeholder: '<name>', description: 'What to call the pane.' }],
    examples: ['teamree terminal rename t_12 --name "auth refactor"'],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const name = readString(context.flags, 'name')
      const terminal = await context.client.call('terminal.rename', { terminalId, label: name ?? null })
      return {
        data: terminal,
        text: formatFields([
          ['id', terminal.id],
          ['name', terminal.label ?? '-'],
          ['title', terminal.title]
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
  },
  {
    path: ['terminal', 'wait'],
    summary: 'Block until a terminal goes quiet or exits.',
    details:
      'Quiet means no output for --quiet-ms; exit means the process ended.\n\n' +
      'Quiet can lie: a command that pauses longer than the quiet window looks finished. For a real exit ' +
      'code use `teamree terminal run`.\n\n' +
      'If this machine sleeps mid-wait, the quiet window restarts on wake and the result carries ' +
      'interrupted: true.',
    args: [TERMINAL_ARG],
    flags: [
      {
        name: 'for',
        kind: 'string',
        placeholder: '<condition>',
        choices: ['quiet', 'exit'],
        description: 'What to wait for. Defaults to quiet.'
      },
      {
        name: 'quiet-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Silence that counts as quiet. Defaults to ${DEFAULT_QUIET_MS}.`
      },
      {
        name: 'timeout-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Give up after this long. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`
      }
    ],
    examples: ['teamree terminal send <id> --text "npm test" --enter && teamree terminal wait <id> --json'],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const until = (readString(context.flags, 'for') ?? 'quiet') as 'quiet' | 'exit'
      const result = await waitForTerminal({
        client: context.client,
        terminalId,
        until,
        quietMs: readNumber(context.flags, 'quiet-ms') ?? DEFAULT_QUIET_MS,
        timeoutMs: readNumber(context.flags, 'timeout-ms') ?? DEFAULT_WAIT_TIMEOUT_MS
      })
      return {
        data: result,
        text: formatFields([
          ['reason', result.reason],
          ['terminal', result.terminalId],
          ['exit code', result.exitCode === undefined ? '-' : String(result.exitCode)],
          ['output bytes', String(result.output.length)],
          ...(result.interrupted
            ? ([['interrupted', 'yes - this machine slept; the quiet window restarted after it woke']] as const)
            : [])
        ])
      }
    }
  },
  {
    path: ['terminal', 'run'],
    summary: 'Run a command in a worktree and wait for it to finish.',
    details:
      'The command gets its own process, so completion is the real process exit rather than a guess from ' +
      'silence. Returns the exit code and everything the command printed. `terminal send` plus ' +
      '`terminal wait` is for driving an interactive shell instead.\n\n' +
      "The CLI's own exit code reports whether teamree ran the command, not whether the command succeeded. " +
      'Read exitCode from the payload for that.',
    flags: [
      {
        name: 'worktree',
        kind: 'string',
        placeholder: '<worktree>',
        description: 'Worktree id, name, path, or branch.',
        required: true
      },
      { name: 'command', kind: 'string', placeholder: '<cmd>', description: 'Command line to run.', required: true },
      {
        name: 'timeout-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Give up after this long. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`
      },
      { name: 'keep', kind: 'boolean', description: 'Leave the pane open after the command exits.' }
    ],
    examples: ['teamree terminal run --worktree fix-login --command "npm test" --json'],
    run: async (context) => {
      const worktree = await resolveWorktree(context.client, requireString(context.flags, 'worktree'))
      const command = requireString(context.flags, 'command')
      const terminal = await context.client.call('terminal.create', { worktreeId: worktree.id, command })

      try {
        const result = await waitForTerminal({
          client: context.client,
          terminalId: terminal.id,
          until: 'exit',
          quietMs: DEFAULT_QUIET_MS,
          timeoutMs: readNumber(context.flags, 'timeout-ms') ?? DEFAULT_WAIT_TIMEOUT_MS
        })
        return {
          data: {
            terminalId: terminal.id,
            exitCode: result.exitCode ?? null,
            output: result.output,
            // Wall-clock time is affected by sleep even though the exit code is not.
            interrupted: result.interrupted
          },
          text: result.output
        }
      } finally {
        if (!readBoolean(context.flags, 'keep')) {
          await context.client.call('terminal.close', { terminalId: terminal.id }).catch(() => {})
        }
      }
    }
  }
]

// Positional like every other worktree command; the flag still works because scripts use it.
function worktreeSelector(positional: string | undefined, flags: ParsedFlags): string {
  const selector = positional ?? readString(flags, 'worktree')
  if (selector === undefined || selector.length === 0) {
    throw new UsageError('terminal create needs <worktree>.', 'Usage: teamree terminal create <worktree>')
  }
  return selector
}
