// The one table. Dispatch and help both read it, so a command cannot exist
// without documentation or documentation without a command.

import { parseArgs, type FlagSpec, type ParsedArgs } from './argv.js'
import { GLOBAL_FLAGS, type CommandSpec } from './command-spec.js'
import { UsageError } from './exit.js'
import { projectCommands } from './commands/project.js'
import { statusCommands } from './commands/status.js'
import { terminalCommands } from './commands/terminal.js'
import { worktreeCommands } from './commands/worktree.js'

export const COMMANDS: readonly CommandSpec[] = [
  ...statusCommands,
  ...projectCommands,
  ...worktreeCommands,
  ...terminalCommands
]

/** Top-level nouns that group subcommands, in declaration order. */
export function commandGroups(): string[] {
  const groups: string[] = []
  for (const spec of COMMANDS) {
    const head = spec.path[0]
    if (head !== undefined && spec.path.length > 1 && !groups.includes(head)) groups.push(head)
  }
  return groups
}

export function findCommand(path: readonly string[]): CommandSpec | undefined {
  return COMMANDS.find(
    (spec) => spec.path.length === path.length && spec.path.every((word, index) => word === path[index])
  )
}

export type Resolution =
  | { kind: 'command'; spec: CommandSpec; rest: string[] }
  /** A bare group such as `teamree worktree`: only useful for help. */
  | { kind: 'group'; group: string }
  | { kind: 'empty' }
  | { kind: 'unknown'; words: string[] }

/**
 * Picks out the command words, skipping global flags so `teamree --json status`
 * reads the same as `teamree status --json`. Value-taking global flags swallow
 * their argument so it is never mistaken for a command word.
 */
export function scanCommandWords(tokens: readonly string[]): { word: string; index: number }[] {
  const words: { word: string; index: number }[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token === '--') break
    if (token.startsWith('-') && token !== '-') {
      const inline = token.includes('=')
      const head = inline ? token.slice(0, token.indexOf('=')) : token
      const spec = GLOBAL_FLAGS.find(
        (candidate) =>
          `--${candidate.name}` === head || (candidate.alias !== undefined && `-${candidate.alias}` === head)
      )
      if (spec && spec.kind !== 'boolean' && !inline) index += 1
      continue
    }
    words.push({ word: token, index })
  }
  return words
}

export function resolveCommand(tokens: readonly string[]): Resolution {
  const words = scanCommandWords(tokens)
  if (words.length === 0) return { kind: 'empty' }

  const longest = Math.max(...COMMANDS.map((spec) => spec.path.length))
  for (let length = Math.min(longest, words.length); length >= 1; length -= 1) {
    const path = words.slice(0, length).map((entry) => entry.word)
    const spec = findCommand(path)
    if (!spec) continue
    const consumed = new Set(words.slice(0, length).map((entry) => entry.index))
    return { kind: 'command', spec, rest: tokens.filter((_, index) => !consumed.has(index)) }
  }

  // A lone group word is a request for its help; a group plus an unmatched word
  // is a typo the caller needs told about.
  const head = words[0]?.word
  if (head !== undefined && words.length === 1 && commandGroups().includes(head)) return { kind: 'group', group: head }
  return { kind: 'unknown', words: words.map((entry) => entry.word) }
}

export function specFlags(spec: CommandSpec): FlagSpec[] {
  return [...GLOBAL_FLAGS, ...(spec.flags ?? [])]
}

/** Parses one command's tokens and checks its positional arity. */
export function parseCommand(spec: CommandSpec, tokens: readonly string[]): ParsedArgs {
  const parsed = parseArgs(tokens, specFlags(spec))
  const args = spec.args ?? []
  const required = args.filter((arg) => arg.required !== false).length

  if (parsed.positionals.length < required) {
    const missing = args[parsed.positionals.length]
    throw new UsageError(
      `${spec.path.join(' ')} needs <${missing?.name ?? 'argument'}>.`,
      `Usage: teamree ${spec.path.join(' ')} ${args.map((arg) => `<${arg.name}>`).join(' ')}`.trim()
    )
  }
  if (parsed.positionals.length > args.length) {
    throw new UsageError(
      `${spec.path.join(' ')} takes ${args.length} argument${
        args.length === 1 ? '' : 's'
      }, got ${parsed.positionals.length}.`,
      `Unexpected: ${parsed.positionals.slice(args.length).join(' ')}`
    )
  }
  return parsed
}
