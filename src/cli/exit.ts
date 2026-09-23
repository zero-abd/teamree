// Exit codes are part of the CLI's contract: a calling agent branches on them
// without parsing prose, so they must stay stable.

export const ExitCode = {
  Success: 0,
  /** The command ran but the runtime refused it, or a selector matched nothing. */
  Failure: 1,
  /** Malformed invocation: unknown command or flag, missing argument, bad value. */
  Usage: 2,
  /** Nothing to talk to: no discovery file, a stale one, or a dead socket. */
  NoRuntime: 3
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

export type SerializedError = {
  code: string
  message: string
  hint?: string
  data?: unknown
  /** The runtime method that refused, when the runtime did. */
  method?: string
}

/** Every failure path funnels through this so exit code and JSON shape agree. */
export class CliError extends Error {
  readonly code: string
  readonly exitCode: ExitCode
  readonly hint: string | undefined
  readonly data: unknown

  constructor(init: { code: string; message: string; exitCode: ExitCode; hint?: string; data?: unknown }) {
    super(init.message)
    this.name = 'CliError'
    this.code = init.code
    this.exitCode = init.exitCode
    this.hint = init.hint
    this.data = init.data
  }

  serialize(): SerializedError {
    const out: SerializedError = { code: this.code, message: this.message }
    if (this.hint !== undefined) out.hint = this.hint
    if (this.data !== undefined) out.data = this.data
    return out
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super({ code: 'usage', message, exitCode: ExitCode.Usage, hint })
    this.name = 'UsageError'
  }
}

export class NoRuntimeError extends CliError {
  constructor(message: string, hint?: string, data?: unknown) {
    super({ code: 'no_runtime', message, exitCode: ExitCode.NoRuntime, hint, data })
    this.name = 'NoRuntimeError'
  }
}

/**
 * A structured error the runtime sent back, keeping its protocol error code.
 *
 * The message is the runtime's own sentence, unprefixed: a person reads
 * `error: worktree "x" holds 1 ignored file…` next to every other error the CLI
 * prints, none of which name an RPC method. The method still matters to a
 * script telling failures apart, so it travels in the JSON document instead.
 */
export class RuntimeCallError extends CliError {
  readonly method: string

  constructor(init: { code: string; message: string; method: string; data?: unknown; hint?: string }) {
    super({ ...init, exitCode: ExitCode.Failure })
    this.name = 'RuntimeCallError'
    this.method = init.method
  }

  override serialize(): SerializedError {
    return { ...super.serialize(), method: this.method }
  }
}

/** Anything thrown that is not already a CliError is a plain command failure. */
export function asCliError(thrown: unknown): CliError {
  if (thrown instanceof CliError) return thrown
  const message = thrown instanceof Error ? thrown.message : String(thrown)
  return new CliError({ code: 'internal', message, exitCode: ExitCode.Failure })
}
