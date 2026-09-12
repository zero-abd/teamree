// Boots the runtime core and hands back a handle the app shuts down with.
// Assembly order matters: state, then handlers, then transports, because a
// client must never reach a dispatcher whose registry is still half-built.

import { join } from 'node:path'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { discoveryFilePath, removeDiscoveryFile, writeDiscoveryFile } from './discoveryFile'
import { registerHandlers } from './handlers/registerHandlers'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext, type RuntimeContext } from './runtimeContext'
import { resolveEndpoint } from './socketEndpoint'
import { startSocketServer, type RuntimeSocketServer } from './socketServer'
import { SubscriptionHub } from './subscriptionHub'

export const WORKSPACE_FILE_NAME = 'workspace.json'

export type RuntimeOptions = {
  userDataDir: string
  version: string
  /** Off for harnesses that only need the dispatcher. */
  serveCli?: boolean
  /** Off when there is no Electron around, e.g. the headless acceptance suite. */
  serveRenderer?: boolean
  onError?: (error: unknown) => void
}

export type Runtime = {
  readonly context: RuntimeContext
  readonly registry: MethodRegistry
  readonly dispatch: Dispatcher
  readonly endpoint: string
  stop: () => Promise<void>
}

export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { userDataDir, version, serveCli = true, serveRenderer = true, onError } = options
  const report = onError ?? ((error: unknown) => console.error('[runtime]', error))

  const store = await WorkspaceStore.open(join(userDataDir, WORKSPACE_FILE_NAME))
  const subscriptions = new SubscriptionHub()
  const context = createRuntimeContext({ version, store, subscriptions })
  const registry = new MethodRegistry(context)
  const areas = registerHandlers(registry)
  const dispatch = createDispatcher(registry)

  let socketServer: RuntimeSocketServer | undefined
  const discoveryPath = discoveryFilePath(userDataDir)

  if (serveCli) {
    const endpoint = resolveEndpoint(userDataDir)
    try {
      socketServer = await startSocketServer({ endpoint, dispatch, subscriptions, onError: report })
      context.endpoint = socketServer.endpoint
      await writeDiscoveryFile(discoveryPath, {
        endpoint: socketServer.endpoint,
        pid: context.pid,
        version,
        startedAt: context.startedAt
      })
    } catch (error) {
      // The GUI is still fully usable without a CLI endpoint, so this is
      // reported and survived rather than fatal.
      report(error)
    }
  }

  // Imported lazily because it pulls in electron, which is absent when the
  // runtime is driven headlessly by the acceptance suite.
  let uninstallBridge = (): void => {}
  if (serveRenderer) {
    const { installIpcBridge } = await import('./ipcBridge')
    uninstallBridge = installIpcBridge({ dispatch, subscriptions })
  }

  return {
    context,
    registry,
    dispatch,
    get endpoint() {
      return context.endpoint
    },
    stop: async () => {
      uninstallBridge()
      // Kills every PTY before the sockets go, so nothing is orphaned.
      await areas.terminals.shutdown().catch(report)
      subscriptions.closeAll()
      if (socketServer) {
        await socketServer.close().catch(report)
        await removeDiscoveryFile(discoveryPath)
      }
      await store.flush().catch(report)
    }
  }
}
