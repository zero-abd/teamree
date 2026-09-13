// THE SEAM. This is the whole surface the runtime wires up.
//
// In src/main/runtime/handlers/registerHandlers.ts:
//
//   import { CliService, findShippedCli, registerCliHandlers } from '../../cli'
//   registerCliHandlers(registry, new CliService({ source: findShippedCli(), administrator: ... }))
//
// The privileged runner is passed in rather than defaulted, so that a service
// built anywhere else — a test, a harness — has no way to reach osascript by
// forgetting an argument.
//
// Handlers receive already-validated params and resolve with exactly the result
// the contract declares. Everything they throw is a RuntimeError, so the
// dispatcher preserves its ErrorCode.

import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { CliService } from './cliService'

export const CLI_METHODS = ['cli.status', 'cli.install', 'cli.dismissPrompt'] as const

export type CliMethodName = (typeof CLI_METHODS)[number]

export type CliHandlers = {
  [M in CliMethodName]: (params: ParamsOf<M>) => Promise<ResultOf<M>>
}

export function createCliHandlers(service: CliService): CliHandlers {
  return {
    'cli.status': () => service.status(),
    'cli.install': () => service.install(),
    'cli.dismissPrompt': () => service.dismissPrompt()
  }
}

export function registerCliHandlers(registry: MethodRegistry, service: CliService): CliService {
  const handlers = createCliHandlers(service)
  registry.register('cli.status', Params.cliStatus, handlers['cli.status'])
  registry.register('cli.install', Params.cliInstall, handlers['cli.install'])
  registry.register('cli.dismissPrompt', Params.cliDismissPrompt, handlers['cli.dismissPrompt'])
  return service
}
