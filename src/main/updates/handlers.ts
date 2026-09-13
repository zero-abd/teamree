// THE SEAM. The whole surface the runtime wires up for the update check.
//
// In src/main/runtime/handlers/registerHandlers.ts:
//
//   import { UpdateService, registerUpdateHandlers } from '../../updates'
//   registerUpdateHandlers(registry, new UpdateService({ ... }))
//
// Four methods, and the shape of them is the argument this feature makes: a
// read, a check somebody asked for, a preference, and opening a download. There
// is no "install", because on an unsigned build there cannot be one — see the
// note at the top of updateService.ts.

import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { UpdateService } from './updateService'

export const UPDATE_METHODS = ['update.state', 'update.check', 'update.setAutomatic', 'update.download'] as const

export type UpdateMethodName = (typeof UPDATE_METHODS)[number]

export type UpdateHandlers = {
  [M in UpdateMethodName]: (params: ParamsOf<M>) => Promise<ResultOf<M>>
}

export function createUpdateHandlers(service: UpdateService): UpdateHandlers {
  return {
    'update.state': async () => service.state(),
    // Always forced: nothing calls this but a person choosing it from the menu
    // or the palette, and the rate limit is about what the app does unasked.
    'update.check': () => service.check({ force: true }),
    'update.setAutomatic': async (params) => service.setAutomatic(params.automatic),
    'update.download': () => service.openDownload()
  }
}

export function registerUpdateHandlers(registry: MethodRegistry, service: UpdateService): UpdateService {
  const handlers = createUpdateHandlers(service)
  registry.register('update.state', Params.updateState, handlers['update.state'])
  registry.register('update.check', Params.updateCheck, handlers['update.check'])
  registry.register('update.setAutomatic', Params.updateSetAutomatic, handlers['update.setAutomatic'])
  registry.register('update.download', Params.updateDownload, handlers['update.download'])
  return service
}
