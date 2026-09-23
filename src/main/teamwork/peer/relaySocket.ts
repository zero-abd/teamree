// The one place a real WebSocket is opened, behind an interface so every rule above it runs without a
// network. Thin on purpose: a socket, four callbacks, and no knowledge of the relay's protocol.

/** What the rest of the peer transport is allowed to do to a socket. */
export type RelaySocket = {
  sendText: (text: string) => void
  sendBinary: (payload: Uint8Array) => void
  /** A closing handshake. Safe to call more than once. */
  close: (code?: number, reason?: string) => void
}

export type RelaySocketHandlers = {
  onOpen: () => void
  onText: (text: string) => void
  onBinary: (payload: Uint8Array) => void
  /**
   * Terminal, and called exactly once however the socket ended. `code` is 0 when the socket failed
   * before it ever produced one: "there was no relay" rather than "the relay said no".
   */
  onClosed: (code: number, reason: string) => void
}

/** Swapped for a fake in tests; the real one is below. */
export type RelayDialer = (url: string, handlers: RelaySocketHandlers) => RelaySocket

/** No close code at all: the socket never got far enough to be given one. */
export const NO_CLOSE_CODE = 0

export const webSocketDialer: RelayDialer = (url, handlers) => {
  let settled = false
  const finish = (code: number, reason: string): void => {
    if (settled) return
    settled = true
    handlers.onClosed(code, reason)
  }

  let socket: WebSocket
  try {
    socket = new WebSocket(url)
  } catch (error) {
    // Reported asynchronously so a caller never handles this one failure differently from the rest.
    queueMicrotask(() => finish(NO_CLOSE_CODE, messageOf(error)))
    return { sendText: () => {}, sendBinary: () => {}, close: () => {} }
  }

  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => handlers.onOpen())
  socket.addEventListener('message', (event: MessageEvent) => {
    // Control is text and content is binary, no exceptions; the wrong one is dropped rather than guessed at.
    if (typeof event.data === 'string') handlers.onText(event.data)
    else if (event.data instanceof ArrayBuffer) handlers.onBinary(new Uint8Array(event.data))
  })
  socket.addEventListener('close', (event: CloseEvent) => finish(event.code, event.reason))
  // The error event carries nothing usable — by design, because a detailed
  // reason is a cross-origin leak in a browser — and a close always follows it.
  socket.addEventListener('error', () => finish(NO_CLOSE_CODE, 'the relay could not be reached'))

  return {
    sendText: (text) => {
      if (socket.readyState === 1) socket.send(text)
    },
    sendBinary: (payload) => {
      if (socket.readyState === 1) socket.send(payload)
    },
    close: (code, reason) => {
      // readyState 0 and 1 are the two a close is legal from; past that asking again throws.
      if (socket.readyState <= 1) socket.close(code, reason)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
