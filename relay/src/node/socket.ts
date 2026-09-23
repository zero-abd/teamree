// Binds a `ws` WebSocket to the core state machine. This file is the whole of
// the relay's dependence on Node and on `ws`: everything it forwards is a frame
// with a length and a direction, and nothing in it decides anything.

import type { WebSocket } from 'ws'
import { PeerSession, type PeerSocket, type SessionHost } from '../core/peerSession.js'

export function attachWebSocket(id: string, origin: string, socket: WebSocket, host: SessionHost): PeerSession {
  const port: PeerSocket = {
    isOpen: () => socket.readyState === socket.OPEN,
    sendText: (text) => socket.send(text, { binary: false }),
    sendBinary: (payload) => socket.send(payload, { binary: true }),
    backlog: () => socket.bufferedAmount,
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    ping: () => socket.ping()
  }

  const session = new PeerSession(id, origin, port, host)

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) session.onBinary(data)
    else session.onText(data.toString('utf8'))
  })
  socket.on('pong', () => session.onPong())
  socket.on('error', (error: Error) => {
    // Frame-level failures are a fact about one peer, never a reason to stop
    // serving. The code is logged and the message is not: `ws` and Node name
    // every failure with a stable code, and a message could quote payload bytes.
    const code = (error as NodeJS.ErrnoException).code
    host.log.warn('connection.error', { conn: id, reason: code ?? error.name })
  })
  socket.on('close', (code: number) => session.onSocketClosed(code))

  return session
}
