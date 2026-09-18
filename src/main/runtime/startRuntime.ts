// Boots the runtime core and hands back a handle the app shuts down with.
// Assembly order matters: state, then handlers, then transports, because a
// client must never reach a dispatcher whose registry is still half-built.
//
// An assembly that fails releases what it had already built before it rethrows.
// Registering the handlers brings the last session's panes back, so by the time
// anything further can fail there are real processes running and no handle to
// them anywhere else: a launch that threw and left them behind would be orphaned
// ptys under a window that never opened.

import { join } from 'node:path'
import { ScrollbackArchive, SCROLLBACK_DIR_NAME } from '../store/scrollbackArchive'
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
  /**
   * Parent of every checkout this runtime creates. Defaults to
   * `~/.teamree/worktrees`, which is where a person's checkouts belong and
   * where the app leaves it.
   *
   * It is settable because `userDataDir` on its own does not isolate a runtime.
   * A harness that points the store at a temporary directory and then creates a
   * worktree still writes the checkout into the real home, under a directory
   * named after the project — so two harnesses running at once, on one machine,
   * are two runtimes choosing checkout names in the same directory with neither
   * able to see the other's records. They pick the same free name, one `git
   * worktree add` wins, and the loser's test reads a path that is not there or
   * belongs to somebody else. The debris outlives both: a checkout left in the
   * user's home for every run that did not get as far as removing it.
   */
  worktreesRoot?: string
  /** Off for harnesses that only need the dispatcher. */
  serveCli?: boolean
  /** Off when there is no Electron around, e.g. the headless acceptance suite. */
  serveRenderer?: boolean
  /**
   * Off for a harness that has no business dialling a relay. On, it costs
   * nothing until a project actually names one: no relay, no connections.
   */
  serveTeamwork?: boolean
  /**
   * Off for a harness that has no business dialling GitHub. On, it costs one
   * request every few hours, made half a minute after startup and awaited by
   * nothing — see updateService.ts.
   */
  checkForUpdates?: boolean
  /**
   * Opens a URL in the user's browser; `shell.openExternal` in the app.
   *
   * Passed in rather than imported so that the only code able to open a browser
   * is code that was handed the means, and so a runtime with no Electron around
   * it — the acceptance host, a vitest worker — simply has none.
   */
  openExternal?: (url: string) => Promise<void>
  onError?: (error: unknown) => void
}

export type Runtime = {
  readonly context: RuntimeContext
  readonly registry: MethodRegistry
  readonly dispatch: Dispatcher
  readonly endpoint: string
  /**
   * Asks GitHub whether there is a newer release, because somebody chose to.
   *
   * On the handle rather than reached through the registry because its one
   * caller is outside the runtime entirely: the macOS app menu is built in the
   * main process, and a menu item is not a method call from a window.
   */
  checkForUpdates: () => Promise<void>
  stop: () => Promise<void>
}

export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const {
    userDataDir,
    version,
    worktreesRoot,
    serveCli = true,
    serveRenderer = true,
    serveTeamwork = true,
    checkForUpdates = true,
    openExternal,
    onError
  } = options
  const report = onError ?? ((error: unknown) => console.error('[runtime]', error))

  const store = await WorkspaceStore.open(join(userDataDir, WORKSPACE_FILE_NAME))
  // After the store, because the sweep needs to know which panes still exist: a
  // transcript whose pane is gone is an orphan, and this is where the ones that
  // were orphaned without anybody closing a pane stop accumulating. A workspace
  // file this launch could not read answers nothing rather than "no panes" —
  // the store is refusing to write over that file because the panes it lists
  // are coming back, and their output has to still be there when they do.
  const scrollback = await ScrollbackArchive.open(
    join(userDataDir, SCROLLBACK_DIR_NAME),
    store.unreadable === undefined ? store.listTerminals().map((record) => record.id) : undefined
  )
  const subscriptions = new SubscriptionHub()
  const context = createRuntimeContext({ version, store, subscriptions })
  const registry = new MethodRegistry(context)
  const areas = registerHandlers(registry, { openExternal, scrollback, worktreesRoot })
  const dispatch = createDispatcher(registry)

  let socketServer: RuntimeSocketServer | undefined
  const discoveryPath = discoveryFilePath(userDataDir)
  // Replaced once the renderer bridge below is installed. A no-op until then,
  // which is part of what makes the teardown safe on a runtime only part-way up.
  let uninstallBridge = (): void => {}

  // Declared before the rest of the assembly rather than inside the handle,
  // because the assembly may not reach the handle and this is what releases
  // what it built. Every step of it works on a runtime that is only part-way
  // up: the bridge is a no-op until one is installed, the areas exist from the
  // moment `registerHandlers` returned, and the socket is released only if
  // there is one.
  const stop = async (): Promise<void> => {
    uninstallBridge()
    // Before anything that takes time: a pending check firing during shutdown
    // would be a request nobody is left to read the answer to.
    areas.updates.stop()
    // First: a relay connection outliving the process it reports on would
    // have a teammate watching panes that are already being killed below.
    areas.peers.stop()
    // Before the PTYs, because a shell dying rewrites files and there is no
    // point reporting changes nobody is left to read.
    areas.worktreeFiles.close()
    areas.teamworkFiles.close()
    // Kills every PTY before the sockets go, so nothing is orphaned.
    await areas.terminals.shutdown().catch(report)
    subscriptions.closeAll()
    if (socketServer) {
      await socketServer.close().catch(report)
      await removeDiscoveryFile(discoveryPath)
    }
    await store.flush().catch(report)
  }

  try {
    // After the dispatcher, and deliberately: a teammate reaching a registry that
    // was still being filled would be told a method does not exist when it merely
    // did not exist yet. Not awaited, because it reads rosters and asks git for a
    // remote, and none of that is a reason for a window to open late — and never
    // fatal, because an app that cannot reach a relay is still an app.
    areas.peers.attach(dispatch)
    if (serveTeamwork) void areas.peers.start().catch(report)

    // Nothing is awaited and nothing is requested yet: this sets a timer for half
    // a minute's time, and the check it eventually makes is best-effort and
    // silent about failing. Startup must cost nothing for it.
    if (checkForUpdates) areas.updates.start()

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

    if (serveRenderer) {
      // Imported lazily because it pulls in electron, which is absent when the
      // runtime is driven headlessly by the acceptance suite.
      const { installIpcBridge } = await import('./ipcBridge')
      uninstallBridge = installIpcBridge({ dispatch, subscriptions })
    }
  } catch (error) {
    // A launch that fails here has already brought the last session's panes
    // back — `registerHandlers` restores them — and is about to hand back no
    // handle at all, so this is the last code that can still reach them. Left
    // alone they would be orphaned ptys under a window that never opened, which
    // is a worse ending than the failure itself. The failure is still the
    // caller's to hear about, so it is rethrown once the releasing is done.
    await stop().catch(report)
    throw error
  }

  return {
    context,
    registry,
    dispatch,
    get endpoint() {
      return context.endpoint
    },
    checkForUpdates: async () => {
      await areas.updates.check({ force: true })
    },
    stop
  }
}
