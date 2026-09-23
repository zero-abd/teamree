// Entry point logic. Kept free of process globals so tests can drive it with
// their own streams, environment, and stub runtime.

import { readBoolean, readNumber, readString } from './argv.js'
import { parseCommand, resolveCommand } from './command-table.js'
import { commandName, type CommandSpec } from './command-spec.js'
import { defaultDiscoveryHost, requireRuntime, type DiscoveryHost } from './discovery.js'
import { asCliError, CliError, ExitCode, UsageError } from './exit.js'
import { helpOutput } from './help.js'
import { emitFailure, emitSuccess, processStreams, type Streams } from './output.js'
import { readProcessStdin, readStdinToEnd } from './stdin.js'
import { connectRuntime, DEFAULT_TIMEOUT_MS, type ConnectOptions, type RuntimeClient } from './transport.js'

export type CliOptions = {
  streams?: Streams
  env?: NodeJS.ProcessEnv
  cwd?: string
  host?: DiscoveryHost
  /** Swappable so tests can supply a client without a socket. */
  connect?: (options: ConnectOptions) => Promise<RuntimeClient>
  /** Swappable so tests can hand a command its stdin. */
  stdin?: () => Promise<string>
}

const HELP_TOKENS = new Set(['--help', '-h'])
const JSON_TOKENS = new Set(['--json', '-j', '--json=true'])

/**
 * Read before parsing: an invocation that is too broken to parse still has to
 * report its failure in the format the caller asked for.
 */
function prescan(tokens: readonly string[]): { json: boolean; help: boolean } {
  let json = false
  let help = false
  for (const token of tokens) {
    if (token === '--') break
    if (JSON_TOKENS.has(token)) json = true
    if (HELP_TOKENS.has(token)) help = true
  }
  return { json, help }
}

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<ExitCode> {
  const streams = options.streams ?? processStreams()
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()

  let tokens = [...argv]
  // `teamree help worktree create` is the same as `teamree worktree create --help`.
  const leadingHelp = tokens.findIndex((token) => !token.startsWith('-'))
  let helpVerb = false
  if (leadingHelp !== -1 && tokens[leadingHelp] === 'help') {
    helpVerb = true
    tokens = [...tokens.slice(0, leadingHelp), ...tokens.slice(leadingHelp + 1)]
  }

  const scan = prescan(tokens)
  const wantsHelp = scan.help || helpVerb
  const json = scan.json
  const resolution = resolveCommand(tokens)
  // Named up front so a failure anywhere below can still say which command it was.
  const label = resolution.kind === 'command' ? commandName(resolution.spec) : tokens.join(' ')

  try {
    if (resolution.kind === 'empty') {
      emitSuccess('help', helpOutput({ kind: 'root' }), json, streams)
      return ExitCode.Success
    }

    if (resolution.kind === 'unknown') {
      throw new UsageError(
        `Unknown command "${resolution.words.join(' ')}".`,
        'Run `teamree --help` to see every command.'
      )
    }

    if (resolution.kind === 'group') {
      const output = helpOutput({ kind: 'group', group: resolution.group })
      if (wantsHelp) {
        emitSuccess('help', output, json, streams)
        return ExitCode.Success
      }
      throw new UsageError(`"${resolution.group}" needs a subcommand.`, output.text)
    }

    const spec: CommandSpec = resolution.spec
    if (wantsHelp) {
      emitSuccess('help', helpOutput({ kind: 'command', spec }), json, streams)
      return ExitCode.Success
    }

    const parsed = parseCommand(spec, resolution.rest)
    const useJson = readBoolean(parsed.flags, 'json') || json
    const timeoutMs = readNumber(parsed.flags, 'timeout') ?? readTimeoutFromEnv(env) ?? DEFAULT_TIMEOUT_MS

    const override = readString(parsed.flags, 'endpoint')
    // The flag names the profile over the environment, so a command line
    // generated for one runtime can never be steered to another by whatever
    // the process that runs it inherited.
    const profile = readString(parsed.flags, 'userDataDir')
    const base: DiscoveryHost = options.host ?? { ...defaultDiscoveryHost(), env }
    const host: DiscoveryHost =
      profile === undefined ? base : { ...base, env: { ...base.env, TEAMREE_USER_DATA_DIR: profile } }

    try {
      const discovered = override === undefined ? requireRuntime(host) : { endpoint: override, source: '--endpoint' }

      const connect = options.connect ?? connectRuntime
      const client = await connect({ endpoint: discovered.endpoint, timeoutMs })
      try {
        const output = await spec.run({
          args: parsed.positionals,
          flags: parsed.flags,
          client,
          json: useJson,
          cwd,
          endpointSource: discovered.source,
          streams,
          // A person piping `--prompt -` is read to the end; a hook's JSON is
          // read inside the agent's turn and so is bounded: see `stdin.ts`.
          stdin: options.stdin ?? (spec.silent ? readProcessStdin : readStdinToEnd)
        })
        if (!spec.silent) emitSuccess(commandName(spec), output, useJson, streams)
        return ExitCode.Success
      } finally {
        client.close()
      }
    } catch (thrown) {
      // Past its arguments, a silent command has nobody to tell: see
      // `CommandSpec.silent`.
      if (spec.silent) return ExitCode.Success
      throw thrown
    }
  } catch (thrown) {
    const error: CliError = asCliError(thrown)
    emitFailure(label, error, json, streams)
    return error.exitCode
  }
}

function readTimeoutFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env['TEAMREE_TIMEOUT_MS']
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}
