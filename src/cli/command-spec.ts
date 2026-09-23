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
  /**
   * Takes every remaining positional rather than one. Only the last argument
   * may be variadic, and a command has at most one — otherwise there is no
   * saying where the first ends and the second begins.
   */
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
  /** Everything on stdin, for a flag whose value is `-`. */
  stdin: () => Promise<string>
  /**
   * For the one command that streams. `teamree team watch --follow` writes a
   * teammate's pane out as it arrives rather than at the end, and there is no
   * way to do that through a returned `CommandOutput`.
   *
   * Every other command must leave this alone and return its output, because
   * `--json` promises exactly one JSON document on stdout and a command writing
   * around the emitter is how that promise gets broken. `team watch` refuses
   * --follow together with --json for exactly that reason, which makes the
   * guarantee structural rather than a rule somebody has to remember.
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
  }
]

export function commandName(spec: Pick<CommandSpec, 'path'>): string {
  return spec.path.join(' ')
}
