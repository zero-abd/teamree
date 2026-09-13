// The one place a real WebSocket is opened, kept behind an interface so every
// rule above it can be tested without a network.
//
// It is deliberately thin: a socket, four callbacks, and no knowledge of the
// relay's protocol. `relayConnection.ts` owns that, which is what lets the
// whole greeting-and-pairing state machine run against a socket made of two
// arrays in a test and against Cloudflare in production, with the same code.

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
   * Terminal, and called exactly once however the socket ended. `code` is 0
   * when the socket failed before it ever produced one — a DNS failure, a
   * refused connection — which is the difference between "the relay said no"
   * and "there was no relay".
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
    // A URL the runtime will not even open — reported asynchronously so a
    // caller never has to handle this one failure differently from the rest.
    queueMicrotask(() => finish(NO_CLOSE_CODE, messageOf(error)))
    return { sendText: () => {}, sendBinary: () => {}, close: () => {} }
  }

  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => handlers.onOpen())
  socket.addEventListener('message', (event: MessageEvent) => {
    // Control is text and content is binary, with no exceptions, in both
    // directions. Anything that arrives as the wrong one is not a frame this
    // protocol has, so it is dropped rather than guessed at.
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
      // readyState 0 and 1 are the two a close is legal from; past that the
      // socket is already going and asking again throws.
      if (socket.readyState <= 1) socket.close(code, reason)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
