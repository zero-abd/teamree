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
  /**
   * Everything on stdin, read once. For a flag whose value is `-`, and for the
   * one command another program runs with something on its stdin — an agent's
   * hook, handing over the hook's JSON, which is read bounded (see
   * `stdin.ts`) and comes back empty when nothing was piped.
   */
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
  /**
   * Prints nothing and exits 0 whatever happens after its arguments parse —
   * no runtime, a refused call, a broken socket. For a command another
   * program runs from a hook, where anything on stdout lands in that
   * program's context and any non-zero exit lands in its transcript as this
   * app's failure. A usage error is still one: the line is generated, so
   * getting it wrong is a bug worth hearing about, and it can only be typed
   * by a person.
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
