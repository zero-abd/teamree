// One error type for the whole terminal service, carrying a protocol error code.
// The dispatcher maps `code` straight onto the wire; no other layer has to know
// how a missing terminal differs from a failed spawn.
//
// It extends the runtime's RuntimeError for the same reason GitServiceError
// does: the dispatcher recognizes that type and only that type, and anything
// else that escapes a handler is reported as `internal` with its code thrown
// away. Subclassing is what makes `not_found`, `conflict`, `invalid_params` and
// `terminal_failed` survive the trip to the wire, so a pane that is simply gone
// stops being reported to callers as a bug in the runtime.

import { ErrorCode } from '../../shared/protocol'
import { RuntimeError } from '../runtime/runtimeError'

export class TerminalServiceError extends RuntimeError {
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(code, message, data)
    this.name = 'TerminalServiceError'
  }
}

export function isTerminalServiceError(value: unknown): value is TerminalServiceError {
  return value instanceof TerminalServiceError
}

export function notFound(message: string, data?: unknown): TerminalServiceError {
  return new TerminalServiceError(ErrorCode.NotFound, message, data)
}

export function conflict(message: string, data?: unknown): TerminalServiceError {
  return new TerminalServiceError(ErrorCode.Conflict, message, data)
}

export function invalidParams(message: string, data?: unknown): TerminalServiceError {
  return new TerminalServiceError(ErrorCode.InvalidParams, message, data)
}

export function terminalFailed(message: string, data?: unknown): TerminalServiceError {
  return new TerminalServiceError(ErrorCode.TerminalFailed, message, data)
}
