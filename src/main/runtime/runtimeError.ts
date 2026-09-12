// The one error type handlers throw. Anything else that escapes a handler is a
// bug, so the dispatcher reports it as `internal` and keeps the message opaque.

import { ErrorCode } from '../../shared/protocol'

export class RuntimeError extends Error {
  readonly code: ErrorCode
  readonly data?: unknown

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'RuntimeError'
    this.code = code
    this.data = data
  }
}

export function notFound(message: string, data?: unknown): RuntimeError {
  return new RuntimeError(ErrorCode.NotFound, message, data)
}

export function conflict(message: string, data?: unknown): RuntimeError {
  return new RuntimeError(ErrorCode.Conflict, message, data)
}

export function internal(message: string, data?: unknown): RuntimeError {
  return new RuntimeError(ErrorCode.Internal, message, data)
}
