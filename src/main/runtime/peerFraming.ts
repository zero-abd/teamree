// Framing, which `src/shared/peer` deliberately does not do. Outer: exactly one
// Noise message per WebSocket binary frame, since Noise carries no length and a
// split or joined message kills the session. Inner: NDJSON lines cut into chunks that fit.

import { MAX_PLAINTEXT_LEN, type PeerSession } from '../../shared/peer'
import { createFrameDecoder } from '../../shared/protocol'

/** Largest plaintext per transport message, a little under the ceiling so a future header has room. */
export const CHUNK_BYTES = MAX_PLAINTEXT_LEN - 64

/** One line of NDJSON as a sequence of Noise transport messages. */
export function encodeLine(session: PeerSession, line: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(line)
  const messages: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    messages.push(session.encrypt(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length))))
  }
  return messages
}

export type LineReader = {
  /** Decrypts one transport message and yields whatever complete lines it completed. */
  push: (message: Uint8Array) => unknown[]
}

/** A tighter ceiling than the protocol's own: this is the one reader fed by a machine that is not ours. */
export const MAX_PEER_FRAME_CHARS = 4 * 1024 * 1024

export function createLineReader(session: PeerSession): LineReader {
  const decode = createFrameDecoder(MAX_PEER_FRAME_CHARS)
  const text = new TextDecoder()
  return {
    push: (message) => {
      const plaintext = session.decrypt(message)
      // `stream: true`: a multi-byte character can straddle two chunks.
      return decode(text.decode(plaintext, { stream: true }))
    }
  }
}
