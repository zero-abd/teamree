// `terminal.pastedImage`: local only, never on the teammate allow-list; a pasted image is this machine's file.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { fileGrants } from '../../files/fileProtocol'
import { defaultResourceSamplerHost } from '../../resources/sampleResources'
import { createPastedImageFinder, type PastedImageDeps } from '../../terminals/pasted-images'

export type PastedImageHandlerOptions = Pick<PastedImageDeps, 'pane'> & Partial<PastedImageDeps>

export function registerPastedImageHandler(registry: MethodRegistry, options: PastedImageHandlerOptions): void {
  const find = createPastedImageFinder({
    ps: defaultResourceSamplerHost.ps,
    grant: (file, version) => fileGrants.grant(file, version),
    ...options
  })
  registry.register('terminal.pastedImage', Params.terminalPastedImage, (params) =>
    find(params.terminalId, params.index)
  )
}
