// THE SEAM: everything the runtime needs from the terminal service. Call
// `await terminals.shutdown()` before quit; nothing else kills the PTYs. Throw
// only TerminalServiceError: a plain Error falls through as `internal`.

import type { z } from 'zod'
import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf, TerminalEvent } from '../../shared/methods'
import { TerminalServiceError } from './service-error'
import { ErrorCode } from '../../shared/protocol'
import { findInstalledAgents } from './agent-discovery'
import { TerminalSessionManager } from './session-manager'
import type { StreamChannel, TerminalSessionManagerOptions } from './session-manager'

export type TerminalMethodName =
  | 'terminal.list'
  | 'terminal.create'
  | 'terminal.write'
  | 'terminal.resize'
  | 'terminal.close'
  | 'terminal.rename'
  | 'terminal.read'
  | 'terminal.subscribe'
  | 'terminal.split'
  | 'terminal.relaunch'
  | 'terminal.agentEvent'
  | 'terminal.closed'
  | 'terminal.reopen'
  | 'layout.get'
  | 'layout.set'
  | 'agent.list'

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
  'terminal.rename': Params.terminalRename,
  'terminal.read': Params.terminalRead,
  'terminal.subscribe': Params.terminalSubscribe,
  'terminal.split': Params.terminalSplit,
  'terminal.relaunch': Params.terminalRelaunch,
  'terminal.agentEvent': Params.terminalAgentEvent,
  'terminal.closed': Params.terminalClosed,
  'terminal.reopen': Params.terminalReopen,
  'layout.get': Params.layoutGet,
  'layout.set': Params.layoutSet,
  'agent.list': Params.agentList
} as const

/** The runtime's subscription hub, reduced to the one call this service makes. */
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
  restoreSessions: () => { restored: number; resumed: number }
  reconcileLayouts: () => number
  /** Escape hatch for callers that need more than the method surface. */
  manager: TerminalSessionManager
}

export function createTerminalService(options: TerminalServiceOptions = {}): TerminalService {
  const manager = options.manager ?? new TerminalSessionManager(options)
  const hub = options.subscriptions

  const handlers: TerminalHandlers = {
    'terminal.list': async (params) => manager.list(params.worktreeId),
    // Probed, not cached: an agent installed without a restart still appears.
    'agent.list': async () => findInstalledAgents(),
    'terminal.create': async (params) => manager.create(params),
    'terminal.write': async (params) => {
      if (params.answering !== undefined) {
        await manager.answer(params.terminalId, params.data, params.answering)
        return { written: true }
      }
      // Absent means a person: only the pane view can see the difference.
      manager.write(params.terminalId, params.data, params.byHand !== false)
      return { written: true }
    },
    'terminal.resize': async (params) => manager.resize(params.terminalId, params.cols, params.rows),
    'terminal.close': async (params) => {
      await manager.close(params.terminalId)
      return { closed: true }
    },
    'terminal.rename': async (params) => manager.rename(params.terminalId, params.label),
    'terminal.read': async (params) => manager.readPlaced(params.terminalId, params.tailBytes),
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
    'terminal.relaunch': async (params) => manager.relaunch(params),
    'terminal.agentEvent': async (params) =>
      manager.agentEvent(params.terminalId, {
        event: params.event,
        at: params.at,
        ...(params.detail === undefined ? {} : { detail: params.detail }),
        ...(params.message === undefined ? {} : { message: params.message })
      }),
    'terminal.closed': async (params) => manager.closedPanes(params.worktreeId),
    'terminal.reopen': async (params) => manager.reopen(params),
    'layout.get': async (params) => manager.layoutGet(params.worktreeId),
    'layout.set': async (params) => manager.layoutSet(params)
  }

  return {
    handlers,
    schemas: terminalMethodSchemas,
    unsubscribe: (subscription) => manager.unsubscribe(subscription),
    shutdown: () => manager.shutdown(),
    restoreSessions: () => manager.restoreSessions(),
    reconcileLayouts: () => manager.reconcileLayouts(),
    manager
  }
}

export function registerTerminalHandlers(registry: MethodRegistry, service: TerminalService): void {
  // One by one, so each registration keeps its own param and result types.
  registry.register('terminal.list', service.schemas['terminal.list'], service.handlers['terminal.list'])
  registry.register('terminal.create', service.schemas['terminal.create'], service.handlers['terminal.create'])
  registry.register('terminal.write', service.schemas['terminal.write'], service.handlers['terminal.write'])
  registry.register('terminal.resize', service.schemas['terminal.resize'], service.handlers['terminal.resize'])
  registry.register('terminal.close', service.schemas['terminal.close'], service.handlers['terminal.close'])
  registry.register('terminal.rename', service.schemas['terminal.rename'], service.handlers['terminal.rename'])
  registry.register('terminal.read', service.schemas['terminal.read'], service.handlers['terminal.read'])
  registry.register('terminal.subscribe', service.schemas['terminal.subscribe'], service.handlers['terminal.subscribe'])
  registry.register('terminal.split', service.schemas['terminal.split'], service.handlers['terminal.split'])
  registry.register('terminal.relaunch', service.schemas['terminal.relaunch'], service.handlers['terminal.relaunch'])
  registry.register(
    'terminal.agentEvent',
    service.schemas['terminal.agentEvent'],
    service.handlers['terminal.agentEvent']
  )
  registry.register('terminal.closed', service.schemas['terminal.closed'], service.handlers['terminal.closed'])
  registry.register('terminal.reopen', service.schemas['terminal.reopen'], service.handlers['terminal.reopen'])
  registry.register('layout.get', service.schemas['layout.get'], service.handlers['layout.get'])
  registry.register('layout.set', service.schemas['layout.set'], service.handlers['layout.set'])
  registry.register('agent.list', service.schemas['agent.list'], service.handlers['agent.list'])
}

export type { StreamChannel, TerminalEvent }
