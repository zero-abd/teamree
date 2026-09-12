// The renderer's transport. It speaks the same protocol as the socket but over
// Electron IPC, so the window never needs a socket, a port, or node access — the
// preload script is the only thing holding an ipcRenderer handle.

import { ipcMain, type WebContents } from 'electron'
import type { StreamEvent } from '../../shared/protocol'
import type { Dispatcher } from './dispatcher'
import { RPC_CALL_CHANNEL, RPC_RELEASE_CHANNEL, RPC_STREAM_CHANNEL } from './ipcChannels'
import type { SubscriptionHub } from './subscriptionHub'

export type IpcBridgeOptions = {
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
}

export function installIpcBridge(options: IpcBridgeOptions): () => void {
  const { dispatch, subscriptions } = options
  // One connection per WebContents; a reload or close ends it and takes every
  // subscription that page opened with it.
  const watched = new WeakSet<WebContents>()

  const connectionIdFor = (sender: WebContents): string => `renderer_${sender.id}`

  const ensureConnection = (sender: WebContents): string => {
    const connectionId = connectionIdFor(sender)
    if (subscriptions.hasConnection(connectionId)) return connectionId

    subscriptions.openConnection(connectionId, (frame: StreamEvent) => {
      if (!sender.isDestroyed()) sender.send(RPC_STREAM_CHANNEL, frame)
    })

    // The next navigation belongs to a different page than the one that
    // subscribed, so its streams end here.
    sender.once('did-start-loading', () => subscriptions.closeConnection(connectionId))
    if (!watched.has(sender)) {
      watched.add(sender)
      sender.once('destroyed', () => subscriptions.closeConnection(connectionId))
    }
    return connectionId
  }

  ipcMain.handle(RPC_CALL_CHANNEL, async (event, raw: unknown) => {
    return dispatch(raw, { connectionId: ensureConnection(event.sender) })
  })

  ipcMain.on(RPC_RELEASE_CHANNEL, (event) => {
    subscriptions.closeConnection(connectionIdFor(event.sender))
  })

  return () => {
    ipcMain.removeHandler(RPC_CALL_CHANNEL)
    ipcMain.removeAllListeners(RPC_RELEASE_CHANNEL)
  }
}
