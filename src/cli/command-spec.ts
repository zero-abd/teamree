// The shape every command declares. Help text, argument checking and dispatch
// all read this one declaration, so they cannot drift apart.

import type { FlagSpec, ParsedFlags } from './argv.js'
import type { CommandOutput, Streams } from './output.js'
import type { RuntimeClient } from './transport.js'

export type ArgSpec = {
  /** Bare name; help renders it as `<name>`. */
  name: string
  description: string
  required?: boolean
  /** Takes every remaining positional; only the last argument, and at most one per command. */
  variadic?: boolean
}

export type CommandContext = {
  args: readonly string[]
  flags: ParsedFlags
  client: RuntimeClient
  json: boolean
  cwd: string
  /** Where the endpoint came from; `status` reports it. */
  endpointSource: string
  /** Everything on stdin, read once and bounded (`stdin.ts`); empty when nothing was piped. */
  stdin: () => Promise<string>
  /**
   * For `team watch --follow` only, which streams. Everyone else returns output, since `--json` promises
   * one document on stdout; `team watch` refuses `--follow` with `--json`.
   */
  streams: Streams
}

export type CommandSpec = {
  /** Words that invoke it, e.g. `['worktree', 'create']`. */
  path: readonly string[]
  summary: string
  details?: string
  args?: readonly ArgSpec[]
  flags?: readonly FlagSpec[]
  examples?: readonly string[]
  /**
   * Prints nothing and exits 0 whatever happens after parsing, for commands run from another program's
   * hook. A usage error still fails: the line is generated, so it is a bug worth hearing.
   */
  silent?: boolean
  run: (context: CommandContext) => Promise<CommandOutput>
}

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'json', kind: 'boolean', alias: 'j', description: 'Print one JSON document on stdout instead of text.' },
  { name: 'help', kind: 'boolean', alias: 'h', description: 'Show help for the command and exit.' },
  {
    name: 'timeout',
    kind: 'number',
    placeholder: '<ms>',
    description: 'Per-request budget in milliseconds (default 15000).'
  },
  {
    name: 'endpoint',
    kind: 'string',
    placeholder: '<path>',
    description: 'Socket path to use instead of the discovered one.'
  },
  {
    name: 'user-data-dir',
    kind: 'string',
    placeholder: '<dir>',
    description: 'Profile whose runtime to talk to; overrides TEAMREE_USER_DATA_DIR.'
  }
]

export function commandName(spec: Pick<CommandSpec, 'path'>): string {
  return spec.path.join(' ')
}
