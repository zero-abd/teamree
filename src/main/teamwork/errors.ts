// Errors this service raises.
//
// They extend the runtime's RuntimeError for the same reason the git service's
// do: the dispatcher recognises that type and only that type, and everything
// else that escapes a handler reaches the caller as `internal` with its code
// thrown away.

import { ErrorCode } from '../../shared/protocol'
import { RuntimeError } from '../runtime/runtimeError'

export class TeamworkError extends RuntimeError {
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(code, message, data)
    this.name = 'TeamworkError'
  }
}

/** The call cannot be answered as asked, and a different argument would fix it. */
export function badHandle(message: string): TeamworkError {
  return new TeamworkError(ErrorCode.InvalidParams, message)
}

/** The repository is already in a state this call would have to overwrite. */
export function rosterConflict(message: string): TeamworkError {
  return new TeamworkError(ErrorCode.Conflict, message)
}
