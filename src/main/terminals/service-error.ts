// One error type for the whole terminal service, carrying a protocol error code.
// The dispatcher maps `code` straight onto the wire; no other layer has to know
// how a missing terminal differs from a failed spawn.

import { ErrorCode } from '../../shared/protocol'

export class TerminalServiceError extends Error {
  readonly code: ErrorCode
  readonly data?: unknown

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'TerminalServiceError'
    this.code = code
    this.data = data
  }
}

export function isTerminalServiceError(value: unknown): value is TerminalServiceError {
  return value instanceof TerminalServiceError
}

export function notFound(message: string, data?: unknown): TerminalServiceError {
  return new TerminalServiceError(ErrorCode.NotFound, message, data)
}

export function invalidParams(message: string, data?: unknown): TerminalServiceError {
  return new TerminalServiceError(ErrorCode.InvalidParams, message, data)
}

export function terminalFailed(message: string, data?: unknown): TerminalServiceError {
  return new TerminalServiceError(ErrorCode.TerminalFailed, message, data)
}
