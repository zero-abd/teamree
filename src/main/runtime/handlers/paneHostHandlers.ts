// Settings › Panes and `teamree host`: what the pane host is running, stopping it, and moving idle shells into it.

import type { PaneHostStatus } from '../../../shared/entities'
import { Params } from '../../../shared/methods'
import type { PaneHostPort } from '../../paneHost/hosting'
import type { TerminalSessionManager } from '../../terminals/session-manager'
import type { MethodRegistry } from '../methodRegistry'

export function registerPaneHostHandlers(
  registry: MethodRegistry,
  options: { paneHost?: PaneHostPort; manager: TerminalSessionManager }
): void {
  const { paneHost, manager } = options

  registry.register('paneHost.status', Params.paneHostStatus, async (): Promise<PaneHostStatus> => {
    const host = (await paneHost?.status()) ?? null
    const counts = { inProcess: manager.inProcessPanes().length, shells: manager.idleShells().length }
    if (host === null) return { running: false, panes: 0, ...counts }
    return { running: true, pid: host.pid, panes: host.panes ?? manager.hostedPanes().length, ...counts }
  })

  registry.register('paneHost.stop', Params.paneHostStop, async () => {
    const attached = manager.hostedPanes().length
    const host = (await paneHost?.stop()) ?? null
    if (host === null) return { stopped: false, panes: 0 }
    return { stopped: true, pid: host.pid, panes: host.panes ?? attached }
  })

  registry.register('paneHost.keepShells', Params.paneHostKeepShells, async (params) => ({
    moved: await manager.keepRunning(params.terminalId)
  }))
}
