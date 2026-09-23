// What everything this app spawned is costing, and the one thing a reader may
// do about a row: ask it to stop.
//
// The kill looks its pid up in a sample it takes on the spot rather than the
// one the window drew from. Two seconds is long enough for a process to end
// and the kernel to hand its number to something else, and the guard is what
// keeps this method off the app's own processes — so it has to be checked
// against what is true now.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { notFound } from '../runtimeError'
import { terminate, type KillSignal } from '../../resources/killProcess'
import { killTarget, type PaneProcess } from '../../resources/resourceTree'
import { createResourceSampler, type ResourceSamplerHost } from '../../resources/sampleResources'

export type ResourcesHandlersOptions = {
  /** The running panes, each with its pty child's pid. */
  panes: () => readonly PaneProcess[]
  appPid?: number
  host?: ResourceSamplerHost
  kill?: KillSignal
}

export function registerResourcesHandlers(registry: MethodRegistry, options: ResourcesHandlersOptions): void {
  const sampler = createResourceSampler({
    panes: options.panes,
    ...(options.appPid === undefined ? {} : { appPid: options.appPid }),
    ...(options.host === undefined ? {} : { host: options.host })
  })

  registry.register('system.resources', Params.systemResources, () => sampler.sample())

  registry.register('system.kill', Params.systemKill, async (params) => {
    const target = killTarget(await sampler.sample(), params.pid)
    if (target === null) throw notFound(`pid ${params.pid} is not under any pane`)
    terminate(target, options.kill)
    return { signalled: true, pid: params.pid, group: target.kind === 'group' }
  })
}
