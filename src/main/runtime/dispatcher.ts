// The single boundary between untrusted wire input and typed handlers. Every
// transport (socket, IPC) funnels through here, so validation and error mapping
// exist exactly once and cannot drift between the CLI and the GUI.

import { ErrorCode, RequestSchema, type ErrorResponse, type Response } from '../../shared/protocol'
import type { CallContext, MethodRegistry } from './methodRegistry'
import { RuntimeError } from './runtimeError'

export type Dispatcher = (raw: unknown, call: CallContext) => Promise<Response>

export function createDispatcher(registry: MethodRegistry): Dispatcher {
  return async (raw, call) => {
    const request = RequestSchema.safeParse(raw)
    if (!request.success) {
      return failure(readId(raw), ErrorCode.BadRequest, 'malformed request envelope', issuesOf(request.error))
    }

    const { id, method, params } = request.data
    const entry = registry.lookup(method)
    if (!entry) return failure(id, ErrorCode.UnknownMethod, `unknown method: ${method}`)

    // Absent params are an empty object so `{}`-shaped methods need no payload.
    const parsed = entry.schema.safeParse(params ?? {})
    if (!parsed.success) {
      return failure(id, ErrorCode.InvalidParams, `invalid params for ${method}`, issuesOf(parsed.error))
    }

    try {
      const result = await entry.handler(parsed.data as never, call)
      return { id, ok: true, result }
    } catch (error) {
      if (error instanceof RuntimeError) return failure(id, error.code, error.message, error.data)
      // An unexpected throw is a runtime bug: report it as internal, keep the
      // message for the log, and never leak a stack over the wire.
      return failure(id, ErrorCode.Internal, messageOf(error))
    }
  }
}

function failure(id: string, code: ErrorCode, message: string, data?: unknown): ErrorResponse {
  const error: ErrorResponse['error'] = data === undefined ? { code, message } : { code, message, data }
  return { id, ok: false, error }
}

/** Best-effort id so even a malformed request can be correlated by the caller. */
function readId(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null && 'id' in raw) {
    const id = (raw as { id: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return ''
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): unknown {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
