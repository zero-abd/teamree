// Errors this service raises. They extend RuntimeError because the dispatcher
// recognises that type and only that type; anything else reaches the caller as `internal`.

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

/** What was typed is not a relay URL. The message carries the remedy `parseRelayUrl` worked out. */
export function badRelayUrl(message: string): TeamworkError {
  return new TeamworkError(ErrorCode.InvalidParams, message)
}

/**
 * What was typed is not an origin: usually a path, and the sentence says which
 * requirement it fell short of.
 */
export function badOriginUrl(message: string): TeamworkError {
  return new TeamworkError(ErrorCode.InvalidParams, message)
}

/** An id that is not shaped like anything this runtime hands out. */
export function badPaneId(message: string): TeamworkError {
  return new TeamworkError(ErrorCode.InvalidParams, message)
}

/** The repository is already in a state this call would have to overwrite. */
export function rosterConflict(message: string): TeamworkError {
  return new TeamworkError(ErrorCode.Conflict, message)
}
