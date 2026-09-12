// Hand-rolled flag parsing. Small on purpose: long flags, one-character
// aliases, `--flag=value`, `--` to stop parsing, and nothing clever about
// abbreviations, so what an agent writes is what it gets.

import { UsageError } from './exit.js'

export type FlagKind = 'boolean' | 'string' | 'number'

export type FlagSpec = {
  /** Long name as typed, kebab-case, without the leading dashes. */
  name: string
  kind: FlagKind
  description: string
  alias?: string
  required?: boolean
  choices?: readonly string[]
  /** Shown in help for value-taking flags, e.g. `<id>`. */
  placeholder?: string
  default?: string | number | boolean
}

export type FlagValue = string | number | boolean
export type ParsedFlags = Record<string, FlagValue | undefined>

export type ParsedArgs = {
  flags: ParsedFlags
  positionals: string[]
}

/** `delete-branch` reads as `deleteBranch` in command code. */
export function flagKey(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase())
}

export function flagLabel(spec: FlagSpec): string {
  const long = `--${spec.name}${spec.kind === 'boolean' ? '' : ` ${spec.placeholder ?? `<${spec.kind}>`}`}`
  return spec.alias ? `-${spec.alias}, ${long}` : long
}

function findSpec(specs: readonly FlagSpec[], token: string): FlagSpec | undefined {
  if (token.startsWith('--')) return specs.find((spec) => spec.name === token.slice(2))
  return specs.find((spec) => spec.alias !== undefined && spec.alias === token.slice(1))
}

function coerce(spec: FlagSpec, raw: string): FlagValue {
  if (spec.kind === 'number') {
    const value = Number(raw)
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new UsageError(`--${spec.name} expects a whole number, got "${raw}".`)
    }
    return value
  }
  if (spec.kind === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new UsageError(`--${spec.name} is a switch; it takes no value (got "${raw}").`)
  }
  if (spec.choices && !spec.choices.includes(raw)) {
    throw new UsageError(`--${spec.name} must be one of ${spec.choices.join(', ')}, got "${raw}".`)
  }
  return raw
}

/**
 * Splits tokens into flags and positionals against `specs`. Throws UsageError
 * (exit code 2) for anything malformed; the caller never sees a partial parse.
 */
export function parseArgs(tokens: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const flags: ParsedFlags = {}
  const positionals: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string

    if (token === '--') {
      positionals.push(...tokens.slice(index + 1))
      break
    }

    // A bare "-" is a conventional stdin placeholder, not a flag.
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }

    const equals = token.indexOf('=')
    const head = equals === -1 ? token : token.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1)

    // `--no-verbose` turns a switch off without needing a value.
    if (inlineValue === undefined && head.startsWith('--no-')) {
      const negated = specs.find((spec) => spec.kind === 'boolean' && spec.name === head.slice(5))
      if (negated) {
        flags[flagKey(negated.name)] = false
        continue
      }
    }

    const spec = findSpec(specs, head)
    if (!spec) throw new UsageError(`Unknown flag ${head}.`, knownFlagsHint(specs))

    if (spec.kind === 'boolean') {
      flags[flagKey(spec.name)] = inlineValue === undefined ? true : coerce(spec, inlineValue)
      continue
    }

    if (inlineValue !== undefined) {
      flags[flagKey(spec.name)] = coerce(spec, inlineValue)
      continue
    }

    const next = tokens[index + 1]
    if (next === undefined) throw new UsageError(`--${spec.name} needs a value.`)
    index += 1
    flags[flagKey(spec.name)] = coerce(spec, next)
  }

  for (const spec of specs) {
    const key = flagKey(spec.name)
    if (flags[key] === undefined && spec.default !== undefined) flags[key] = spec.default
    if (flags[key] === undefined && spec.required) {
      throw new UsageError(`--${spec.name} is required.`)
    }
  }

  return { flags, positionals }
}

function knownFlagsHint(specs: readonly FlagSpec[]): string {
  const names = specs.map((spec) => `--${spec.name}`).sort()
  return names.length > 0 ? `Known flags: ${names.join(', ')}.` : 'This command takes no flags.'
}

export function readString(flags: ParsedFlags, name: string): string | undefined {
  const value = flags[flagKey(name)]
  return typeof value === 'string' ? value : undefined
}

/** For flags the spec marks required, so a miss here is a programming error. */
export function requireString(flags: ParsedFlags, name: string): string {
  const value = readString(flags, name)
  if (value === undefined || value.length === 0) throw new UsageError(`--${name} is required.`)
  return value
}

export function readNumber(flags: ParsedFlags, name: string): number | undefined {
  const value = flags[flagKey(name)]
  return typeof value === 'number' ? value : undefined
}

export function readBoolean(flags: ParsedFlags, name: string): boolean {
  return flags[flagKey(name)] === true
}
