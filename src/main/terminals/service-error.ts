// One error type for the whole terminal service, carrying a protocol error code.
// Extends RuntimeError because the dispatcher recognises that type and only
// that type; anything else is reported as `internal` with its code thrown away.

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
