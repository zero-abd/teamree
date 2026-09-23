// The renderer's transport. It speaks the same protocol as the socket but over
// Electron IPC, so the window never needs a socket, a port, or node access — the
// preload script is the only thing holding an ipcRenderer handle.

import { ipcMain, type WebContents } from 'electron'
import { ErrorCode, type ErrorResponse, type StreamEvent } from '../../shared/protocol'
import type { Dispatcher } from './dispatcher'
import { RPC_CALL_CHANNEL, RPC_RELEASE_CHANNEL, RPC_STREAM_CHANNEL } from './ipcChannels'
import type { SubscriptionHub } from './subscriptionHub'

export type IpcBridgeOptions = {
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
}

export function installIpcBridge(options: IpcBridgeOptions): () => void {
  const { dispatch, subscriptions } = options
  // One connection per WebContents; a reload or close ends it and its subscriptions.
  const watched = new WeakSet<WebContents>()

  const connectionIdFor = (sender: WebContents): string => `renderer_${sender.id}`

  const ensureConnection = (sender: WebContents): string => {
    const connectionId = connectionIdFor(sender)
    if (subscriptions.hasConnection(connectionId)) return connectionId

    subscriptions.openConnection(connectionId, (frame: StreamEvent) => {
      if (!sender.isDestroyed()) sender.send(RPC_STREAM_CHANNEL, frame)
    })

    // The next navigation is a different page, so its streams end here.
    sender.once('did-start-loading', () => subscriptions.closeConnection(connectionId))
    if (!watched.has(sender)) {
      watched.add(sender)
      sender.once('destroyed', () => subscriptions.closeConnection(connectionId))
    }
    return connectionId
  }

  // A previous bridge may have left its closing handler behind (below); a
  // second `handle` on a taken channel throws, so the channel is cleared first.
  ipcMain.removeHandler(RPC_CALL_CHANNEL)
  ipcMain.handle(RPC_CALL_CHANNEL, async (event, raw: unknown) => {
    return dispatch(raw, { connectionId: ensureConnection(event.sender) })
  })

  ipcMain.on(RPC_RELEASE_CHANNEL, (event) => {
    subscriptions.closeConnection(connectionIdFor(event.sender))
  })

  return () => {
    ipcMain.removeHandler(RPC_CALL_CHANNEL)
    ipcMain.removeAllListeners(RPC_RELEASE_CHANNEL)
    // The bridge comes down first in `stop()`, while the window is still open. A call
    // made then used to land on a channel with no handler, which Electron logs as an
    // error and rejects with its own wording; instead the channel keeps answering.
    ipcMain.handle(RPC_CALL_CHANNEL, async (_event, raw: unknown) => closing(raw))
  }
}

/** The answer to a call made after the bridge has come down. */
function closing(raw: unknown): ErrorResponse {
  const id =
    typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
      ? (raw as { id: string }).id
      : ''
  return { id, ok: false, error: { code: ErrorCode.Internal, message: 'teamree is quitting.' } }
}
