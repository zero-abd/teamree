// THE SEAM. Everything the runtime needs from this service is in this file.
//
// createTerminalService() returns one `handlers` object keyed by the exact method
// names in the contract, plus the matching Zod schema for each, plus a
// registerTerminalHandlers() that feeds both into the runtime's MethodRegistry.
// The whole wiring, in handlers/registerHandlers.ts:
//
//   const terminals = createTerminalService({
//     subscriptions: registry.context.subscriptions,
//     resolveWorktreeCwd: (id) => registry.context.store.getWorktree(id)?.path,
//     layouts: registry.context.store
//   })
//   registerTerminalHandlers(registry, terminals)
//
// Keep `terminals` and call `await terminals.shutdown()` before the app quits:
// that is what kills the PTYs, and nothing else does.
//
// Notes on the two halves neither side should guess at:
//   - Subscriptions belong to the connection, so terminal.subscribe delegates to
//     the hub and the global `unsubscribe` method keeps working untouched. With
//     no hub configured the service keeps its own ids instead and pushes events
//     through the `publish` option, which is how the tests run it headless.
//   - Failures throw TerminalServiceError, whose `code` is already an ErrorCode;
//     map it onto the response (see isTerminalServiceError) rather than letting
//     it fall through as `internal`.

import type { z } from 'zod'
import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf, TerminalEvent } from '../../shared/methods'
import { TerminalServiceError } from './service-error'
import { ErrorCode } from '../../shared/protocol'
import { TerminalSessionManager } from './session-manager'
import type { StreamChannel, TerminalSessionManagerOptions } from './session-manager'

export type TerminalMethodName =
  | 'terminal.list'
  | 'terminal.create'
  | 'terminal.write'
  | 'terminal.resize'
  | 'terminal.close'
  | 'terminal.read'
  | 'terminal.subscribe'
  | 'terminal.split'
  | 'layout.get'
  | 'layout.set'

/** Per-call identity, as the dispatcher passes it to every handler. */
export type TerminalCallContext = { readonly connectionId: string }

export type TerminalHandlers = {
  [M in TerminalMethodName]: (params: ParamsOf<M>, call?: TerminalCallContext) => Promise<ResultOf<M>>
}

/** Params schema per method, taken from the contract rather than restated. */
export const terminalMethodSchemas = {
  'terminal.list': Params.terminalList,
  'terminal.create': Params.terminalCreate,
  'terminal.write': Params.terminalWrite,
  'terminal.resize': Params.terminalResize,
  'terminal.close': Params.terminalClose,
  'terminal.read': Params.terminalRead,
  'terminal.subscribe': Params.terminalSubscribe,
  'terminal.split': Params.terminalSplit,
  'layout.get': Params.layoutGet,
  'layout.set': Params.layoutSet
} as const

/**
 * The runtime's subscription hub, reduced to the one call this service makes.
 * The source it is given returns the teardown for that subscription.
 */
export type SubscriptionRegistrar = {
  subscribe(connectionId: string, source: (channel: StreamChannel) => () => void): string
}

/** The runtime's MethodRegistry, reduced to what registration needs. */
export type MethodRegistry = {
  register<M extends TerminalMethodName>(
    method: M,
    schema: z.ZodType<ParamsOf<M>>,
    handler: (params: ParamsOf<M>, call: TerminalCallContext) => Promise<ResultOf<M>>
  ): void
}

export type TerminalServiceOptions = TerminalSessionManagerOptions & {
  /** Usually `registry.context.subscriptions`. */
  subscriptions?: SubscriptionRegistrar
  /** Reuse an existing manager instead of letting the service make one. */
  manager?: TerminalSessionManager
}

export type TerminalService = {
  handlers: TerminalHandlers
  schemas: typeof terminalMethodSchemas
  /** Only for streams this service keeps ids for; a hub owns its own. */
  unsubscribe: (subscription: string) => boolean
  /** Kills every PTY. Call before the app quits. */
  shutdown: () => Promise<void>
  /** Drops stored pane leaves whose terminal is gone. Call once at startup. */
  reconcileLayouts: () => number
  /** Escape hatch for callers that need more than the method surface. */
  manager: TerminalSessionManager
}

export function createTerminalService(options: TerminalServiceOptions = {}): TerminalService {
  const manager = options.manager ?? new TerminalSessionManager(options)
  const hub = options.subscriptions

  const handlers: TerminalHandlers = {
    'terminal.list': async (params) => manager.list(params.worktreeId),
    'terminal.create': async (params) => manager.create(params),
    'terminal.write': async (params) => {
      manager.write(params.terminalId, params.data)
      return { written: true }
    },
    'terminal.resize': async (params) => manager.resize(params.terminalId, params.cols, params.rows),
    'terminal.close': async (params) => {
      await manager.close(params.terminalId)
      return { closed: true }
    },
    'terminal.read': async (params) => ({ data: manager.read(params.terminalId, params.tailBytes) }),
    'terminal.subscribe': async (params, call) => {
      if (!hub) return { subscription: manager.subscribe(params.terminalId) }
      if (!call) {
        throw new TerminalServiceError(ErrorCode.Internal, 'terminal.subscribe needs the calling connection')
      }
      return {
        subscription: hub.subscribe(call.connectionId, (channel) => manager.attachStream(params.terminalId, channel))
      }
    },
    'terminal.split': async (params) => manager.split(params),
    'layout.get': async (params) => manager.layoutGet(params.worktreeId),
    'layout.set': async (params) => manager.layoutSet(params)
  }

  return {
    handlers,
    schemas: terminalMethodSchemas,
    unsubscribe: (subscription) => manager.unsubscribe(subscription),
    shutdown: () => manager.shutdown(),
    reconcileLayouts: () => manager.reconcileLayouts(),
    manager
  }
}

export function registerTerminalHandlers(registry: MethodRegistry, service: TerminalService): void {
  // Listed one by one rather than looped so each registration keeps the method's
  // own param and result types instead of collapsing to the union.
  registry.register('terminal.list', service.schemas['terminal.list'], service.handlers['terminal.list'])
  registry.register('terminal.create', service.schemas['terminal.create'], service.handlers['terminal.create'])
  registry.register('terminal.write', service.schemas['terminal.write'], service.handlers['terminal.write'])
  registry.register('terminal.resize', service.schemas['terminal.resize'], service.handlers['terminal.resize'])
  registry.register('terminal.close', service.schemas['terminal.close'], service.handlers['terminal.close'])
  registry.register('terminal.read', service.schemas['terminal.read'], service.handlers['terminal.read'])
  registry.register('terminal.subscribe', service.schemas['terminal.subscribe'], service.handlers['terminal.subscribe'])
  registry.register('terminal.split', service.schemas['terminal.split'], service.handlers['terminal.split'])
  registry.register('layout.get', service.schemas['layout.get'], service.handlers['layout.get'])
  registry.register('layout.set', service.schemas['layout.set'], service.handlers['layout.set'])
}

export type { StreamChannel, TerminalEvent }
