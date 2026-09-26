// Boots the runtime core and hands back a handle the app shuts down with.
// Assembly order matters: state, then handlers, then transports, because a
// client must never reach a dispatcher whose registry is still half-built.

import { join } from 'node:path'
import type { AgentNotice } from '../agentNotices'
import type { SharedNoteSummary } from '../../shared/sharedNote'
import type { Appearance, Tone } from '../../shared/theme'
import { ScrollbackArchive, SCROLLBACK_DIR_NAME } from '../store/scrollbackArchive'
import type { SelfInstall } from '../updates'
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
   * Parent of every checkout; defaults to `~/.teamree/worktrees`. Settable because
   * `userDataDir` alone does not isolate a runtime: two harnesses sharing the real
   * home pick the same free checkout name and one `git worktree add` loses.
   */
  worktreesRoot?: string
  /** Off for harnesses that only need the dispatcher. */
  serveCli?: boolean
  /** Off when there is no Electron around, e.g. the headless acceptance suite. */
  serveRenderer?: boolean
  /** Off for a harness that has no business dialling a relay. Costs nothing until a project names one. */
  serveTeamwork?: boolean
  /** Off for a harness that has no business dialling GitHub; see updateService.ts. */
  checkForUpdates?: boolean
  /** Fetches each project's base ref in the background. Off unless asked: a harness must never reach a real remote. */
  fetchBases?: boolean
  /** `net.isOnline` in the app; false skips a background fetch. */
  online?: () => boolean
  /**
   * Opens a URL in the user's browser; `shell.openExternal` in the app. Passed in
   * so only code handed the means can open a browser, and a headless runtime has none.
   */
  openExternal?: (url: string) => Promise<void>
  /** Where the update's `.dmg` is saved; `app.getPath('downloads')` in the app. */
  downloadsDirectory?: string
  /** Opens the fetched `.dmg`; `shell.openPath` in the app. */
  openPath?: (path: string) => Promise<string>
  /** Replaces the packaged app in place after a quit; see updates/selfInstaller.ts. */
  selfInstall?: SelfInstall
  /** Moves a discarded untracked file to the Trash; `shell.trashItem` in the app. */
  trashItem?: (path: string) => Promise<void>
  /** Announces an agent pane that has stopped. Passed in for the same reason `openExternal` is. */
  onAgentNotice?: (notice: AgentNotice) => void
  /** Announces a note a teammate shared; see `onAgentNotice`. */
  onSharedNote?: (note: SharedNoteSummary) => void
  /** Ends the app, for `teamree quit`; `app.quit` in the main process. Absent, the method refuses. */
  requestQuit?: (force: boolean) => void
  /** The window's edited files, which `teamree quit` refuses over without `--force`. */
  unsavedFiles?: () => readonly string[]
  /** Hears each stored appearance, so the app can point macOS's own appearance at it. */
  onAppearance?: (appearance: Appearance) => void
  /** What macOS is showing; `nativeTheme` in the app. */
  systemTone?: () => Tone
  onError?: (error: unknown) => void
}

export type Runtime = {
  readonly context: RuntimeContext
  readonly registry: MethodRegistry
  readonly dispatch: Dispatcher
  readonly endpoint: string
  /**
   * Asks GitHub whether there is a newer release. On the handle because its one
   * caller, the macOS app menu, is not a method call from a window.
   */
  checkForUpdates: () => Promise<void>
  /** A quit was declined at its questions, so a Restart to Update that started it installs nothing. */
  quitDeclined: () => void
  /** The window came to the front: a moment to see whether the base refs moved, or a long absence to check updates over. */
  noteWindowFocus: () => void
  /** The window left the front: the moment a long absence away is measured from. */
  noteWindowBlur: () => void
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
    fetchBases = false,
    online,
    openExternal,
    downloadsDirectory,
    openPath,
    selfInstall,
    trashItem,
    onAgentNotice,
    onSharedNote,
    requestQuit,
    unsavedFiles,
    onAppearance,
    systemTone,
    onError
  } = options
  const report = onError ?? ((error: unknown) => console.error('[runtime]', error))

  const store = await WorkspaceStore.open(join(userDataDir, WORKSPACE_FILE_NAME))
  // After the store, because the sweep needs to know which panes still exist. A
  // workspace file this launch could not read answers nothing rather than "no
  // panes": its panes are coming back and their output has to still be there.
  const scrollback = await ScrollbackArchive.open(
    join(userDataDir, SCROLLBACK_DIR_NAME),
    store.unreadable === undefined ? store.listTerminals().map((record) => record.id) : undefined
  )
  const subscriptions = new SubscriptionHub()
  const context = createRuntimeContext({ version, store, subscriptions })
  const registry = new MethodRegistry(context)
  const endpoint = serveCli ? resolveEndpoint(userDataDir) : undefined
  const areas = registerHandlers(registry, {
    openExternal,
    downloadsDirectory,
    openPath,
    ...(selfInstall === undefined ? {} : { selfInstall }),
    ...(trashItem === undefined ? {} : { trashItem }),
    onAgentNotice,
    ...(onSharedNote === undefined ? {} : { onSharedNote }),
    scrollback,
    worktreesRoot,
    ...(requestQuit === undefined ? {} : { requestQuit }),
    ...(unsavedFiles === undefined ? {} : { unsavedFiles }),
    ...(onAppearance === undefined ? {} : { onAppearance }),
    ...(systemTone === undefined ? {} : { systemTone }),
    ...(online === undefined ? {} : { online }),
    ...(endpoint === undefined ? {} : { paneEndpoint: endpoint })
  })
  const dispatch = createDispatcher(registry)

  let socketServer: RuntimeSocketServer | undefined
  const discoveryPath = discoveryFilePath(userDataDir)
  let wroteDiscovery = false
  // Replaced once the renderer bridge below is installed; a no-op until then.
  let uninstallBridge = (): void => {}

  // Declared before the rest of the assembly because the assembly may not reach
  // the handle, and every step works on a runtime only part-way up. Each step is
  // its own: one that throws is reported and the next still runs, so the socket
  // and discovery file, which the world outside can see, go last and regardless.
  const stop = async (): Promise<void> => {
    const step = async (release: () => void | Promise<void>): Promise<void> => {
      try {
        await release()
      } catch (error) {
        report(error)
      }
    }
    await step(uninstallBridge)
    // A pending check firing during shutdown would be a request nobody reads.
    await step(() => areas.updates.stop())
    await step(() => areas.bases.stop())
    // Before the PTYs: a teammate must not watch panes already being killed.
    await step(() => areas.peers.stop())
    // Before the PTYs, because a shell dying rewrites files.
    await step(() => areas.worktreeFiles.close())
    await step(() => areas.teamworkFiles.close())
    // Kills every PTY before the sockets go, so nothing is orphaned.
    await step(() => areas.terminals.shutdown())
    await step(() => subscriptions.closeAll())
    if (socketServer) await step(socketServer.close)
    // Whether or not the socket was ever bound: only this process writes the file.
    if (wroteDiscovery) await step(() => removeDiscoveryFile(discoveryPath))
    await step(() => store.flush())
  }

  try {
    // After the dispatcher: a teammate reaching a half-filled registry would be
    // told a method does not exist. Not awaited, and never fatal: an app that
    // cannot reach a relay is still an app.
    areas.peers.attach(dispatch)
    if (serveTeamwork) void areas.peers.start().catch(report)

    // Only sets a timer; startup must cost nothing for it.
    if (checkForUpdates) areas.updates.start()
    if (fetchBases) areas.bases.start()

    if (endpoint !== undefined) {
      try {
        socketServer = await startSocketServer({ endpoint, dispatch, subscriptions, onError: report })
        context.endpoint = socketServer.endpoint
        // Claimed before the write: a write that failed half way is still a file to take away.
        wroteDiscovery = true
        await writeDiscoveryFile(discoveryPath, {
          endpoint: socketServer.endpoint,
          pid: context.pid,
          version,
          startedAt: context.startedAt
        })
      } catch (error) {
        // The GUI is fully usable without a CLI endpoint.
        report(error)
      }
    }

    if (serveRenderer) {
      // Imported lazily because it pulls in electron, absent under the acceptance suite.
      const { installIpcBridge } = await import('./ipcBridge')
      uninstallBridge = installIpcBridge({ dispatch, subscriptions })
    }
  } catch (error) {
    // `registerHandlers` already brought the last session's panes back, and no
    // handle will reach the caller: left alone they would be orphaned ptys under
    // a window that never opened.
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
      await areas.updates.check({ force: true, person: true })
    },
    quitDeclined: () => areas.updates.quitDeclined(),
    noteWindowFocus: () => {
      if (fetchBases) void areas.bases.nudge()
      areas.updates.noteWindowFocus()
    },
    noteWindowBlur: () => areas.updates.noteWindowBlur(),
    stop
  }
}
