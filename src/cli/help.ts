// Help is rendered from the command table, never written by hand, so it cannot
// describe a flag the parser does not accept.

import { flagLabel, type FlagSpec } from './argv.js'
import { COMMANDS, commandGroups } from './command-table.js'
import { GLOBAL_FLAGS, commandName, type CommandSpec } from './command-spec.js'
import { ExitCode } from './exit.js'
import type { CommandOutput } from './output.js'

const BINARY = 'teamree'

const EXIT_CODES: ReadonlyArray<readonly [ExitCode, string]> = [
  [ExitCode.Success, 'success'],
  [ExitCode.Failure, 'command failed'],
  [ExitCode.Usage, 'usage error'],
  [ExitCode.NoRuntime, 'no runtime running']
]

function indentedList(entries: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(0, ...entries.map(([left]) => left.length))
  return entries.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join('\n')
}

function flagEntries(flags: readonly FlagSpec[]): Array<readonly [string, string]> {
  return flags.map((flag) => {
    const notes: string[] = []
    if (flag.required) notes.push('required')
    if (flag.choices) notes.push(`one of ${flag.choices.join('|')}`)
    return [flagLabel(flag), notes.length > 0 ? `${flag.description} (${notes.join('; ')})` : flag.description] as const
  })
}

export function usageLine(spec: CommandSpec): string {
  const parts = [BINARY, ...spec.path]
  for (const arg of spec.args ?? []) parts.push(arg.required === false ? `[<${arg.name}>]` : `<${arg.name}>`)
  for (const flag of spec.flags ?? []) {
    if (!flag.required) continue
    parts.push(`--${flag.name}${flag.kind === 'boolean' ? '' : ` ${flag.placeholder ?? `<${flag.kind}>`}`}`)
  }
  if ((spec.flags ?? []).some((flag) => !flag.required)) parts.push('[flags]')
  return parts.join(' ')
}

export function renderRootHelp(): string {
  const sections = [
    `${BINARY} — drive the teamree desktop app from a shell.`,
    '',
    'Usage:',
    `  ${BINARY} <command> [arguments] [flags]`,
    '',
    'Commands:',
    indentedList(COMMANDS.map((spec) => [commandName(spec), spec.summary] as const)),
    '',
    'Global flags:',
    indentedList(flagEntries(GLOBAL_FLAGS)),
    '',
    'Exit codes:',
    indentedList(EXIT_CODES.map(([code, meaning]) => [String(code), meaning] as const)),
    '',
    'Selectors:',
    '  Projects and worktrees accept an id, a name, a path, or a unique id prefix;',
    '  worktrees also accept a branch name. An ambiguous selector is an error.',
    '',
    `Run \`${BINARY} <command> --help\` for details, or add --json to any command for machine-readable output.`
  ]
  return sections.join('\n')
}

export function renderGroupHelp(group: string): string {
  const members = COMMANDS.filter((spec) => spec.path[0] === group)
  return [
    `${BINARY} ${group} — ${members.length} command${members.length === 1 ? '' : 's'}.`,
    '',
    'Commands:',
    indentedList(members.map((spec) => [commandName(spec), spec.summary] as const)),
    '',
    `Run \`${BINARY} ${group} <command> --help\` for details.`
  ].join('\n')
}

export function renderCommandHelp(spec: CommandSpec): string {
  const sections = [`${BINARY} ${commandName(spec)} — ${spec.summary}`]
  if (spec.details) sections.push('', spec.details)
  sections.push('', 'Usage:', `  ${usageLine(spec)}`)

  const args = spec.args ?? []
  if (args.length > 0) {
    sections.push('', 'Arguments:', indentedList(args.map((arg) => [`<${arg.name}>`, arg.description] as const)))
  }
  if ((spec.flags ?? []).length > 0) {
    sections.push('', 'Flags:', indentedList(flagEntries(spec.flags ?? [])))
  }
  sections.push('', 'Global flags:', indentedList(flagEntries(GLOBAL_FLAGS)))
  if ((spec.examples ?? []).length > 0) {
    sections.push('', 'Examples:', (spec.examples ?? []).map((example) => `  ${example}`).join('\n'))
  }
  return sections.join('\n')
}

function describeFlags(flags: readonly FlagSpec[]): unknown[] {
  return flags.map((flag) => ({
    name: flag.name,
    kind: flag.kind,
    alias: flag.alias ?? null,
    required: flag.required === true,
    choices: flag.choices ?? null,
    description: flag.description
  }))
}

/** The whole command surface as data, for an agent discovering the CLI. */
export function helpDocument(scope?: readonly string[]): unknown {
  const commands = scope === undefined
    ? COMMANDS
    : COMMANDS.filter((spec) => scope.every((word, index) => spec.path[index] === word))
  return {
    binary: BINARY,
    groups: commandGroups(),
    exitCodes: Object.fromEntries(EXIT_CODES.map(([code, meaning]) => [code, meaning])),
    globalFlags: describeFlags(GLOBAL_FLAGS),
    commands: commands.map((spec) => ({
      name: commandName(spec),
      path: spec.path,
      summary: spec.summary,
      details: spec.details ?? null,
      usage: usageLine(spec),
      args: (spec.args ?? []).map((arg) => ({
        name: arg.name,
        required: arg.required !== false,
        description: arg.description
      })),
      flags: describeFlags(spec.flags ?? []),
      examples: spec.examples ?? []
    }))
  }
}

export function helpOutput(target: { kind: 'root' } | { kind: 'group'; group: string } | { kind: 'command'; spec: CommandSpec }): CommandOutput {
  if (target.kind === 'root') return { data: helpDocument(), text: renderRootHelp() }
  if (target.kind === 'group') return { data: helpDocument([target.group]), text: renderGroupHelp(target.group) }
  return { data: helpDocument(target.spec.path), text: renderCommandHelp(target.spec) }
}
