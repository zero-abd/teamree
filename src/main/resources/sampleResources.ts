// One sample: the pane list, one `ps`, and the tree read from both.

import { execFile } from 'node:child_process'
import type { SystemResources } from '../../shared/entities'
import { parsePsTable, PS_ARGS } from './psTable'
import { aggregateResources, type PaneProcess } from './resourceTree'

/** Everything the sampler needs from the OS, so a test can hand it a table. */
export type ResourceSamplerHost = {
  /** The text of `ps -axo pid,ppid,pcpu,rss,comm`, or empty where there is no ps. */
  ps: () => Promise<string>
  now: () => number
}

/** A whole machine's table is a few hundred kilobytes. */
const PS_MAX_BUFFER = 8 * 1024 * 1024

export const defaultResourceSamplerHost: ResourceSamplerHost = {
  ps: () =>
    new Promise((resolve) => {
      // No `ps` on Windows: an empty sample, not an error on every open of the popover.
      if (process.platform === 'win32') return resolve('')
      execFile('ps', [...PS_ARGS], { maxBuffer: PS_MAX_BUFFER }, (error, stdout) => resolve(error ? '' : stdout))
    }),
  now: () => Date.now()
}

export type ResourceSampler = { sample: () => Promise<SystemResources> }

export function createResourceSampler(deps: {
  panes: () => readonly PaneProcess[]
  appPid?: number
  host?: ResourceSamplerHost
}): ResourceSampler {
  const host = deps.host ?? defaultResourceSamplerHost
  const appPid = deps.appPid ?? process.pid
  return {
    sample: async () => {
      // Panes first, then ps: the other order shows a pane with no tree.
      const panes = deps.panes()
      const table = await host.ps()
      return aggregateResources({ sampledAt: host.now(), processes: parsePsTable(table), panes, appPid })
    }
  }
}
