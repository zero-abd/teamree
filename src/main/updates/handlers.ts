// THE SEAM: the whole surface the runtime wires up for updates. No "install": on
// an unsigned build there cannot be one, only a verified `.dmg` to open (see updateService.ts).

import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { UpdateService } from './updateService'

export const UPDATE_METHODS = [
  'update.state',
  'update.check',
  'update.setAutomatic',
  'update.download',
  'update.fetchInstaller',
  'update.openInstaller'
] as const

export type UpdateMethodName = (typeof UPDATE_METHODS)[number]

export type UpdateHandlers = {
  [M in UpdateMethodName]: (params: ParamsOf<M>) => Promise<ResultOf<M>>
}

export function createUpdateHandlers(service: UpdateService): UpdateHandlers {
  return {
    'update.state': async () => service.state(),
    // Always forced: only a person calls this, and the rate limit is about what the app does unasked.
    'update.check': () => service.check({ force: true }),
    'update.setAutomatic': async (params) => service.setAutomatic(params.automatic),
    'update.download': () => service.openDownload(),
    'update.fetchInstaller': () => service.fetchInstaller(),
    'update.openInstaller': () => service.openInstaller()
  }
}

export function registerUpdateHandlers(registry: MethodRegistry, service: UpdateService): UpdateService {
  const handlers = createUpdateHandlers(service)
  registry.register('update.state', Params.updateState, handlers['update.state'])
  registry.register('update.check', Params.updateCheck, handlers['update.check'])
  registry.register('update.setAutomatic', Params.updateSetAutomatic, handlers['update.setAutomatic'])
  registry.register('update.download', Params.updateDownload, handlers['update.download'])
  registry.register('update.fetchInstaller', Params.updateFetchInstaller, handlers['update.fetchInstaller'])
  registry.register('update.openInstaller', Params.updateOpenInstaller, handlers['update.openInstaller'])
  return service
}
