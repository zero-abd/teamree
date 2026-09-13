// Framing, which `src/shared/peer` deliberately does not do.
//
// There are two boundaries to keep and they are not the same one.
//
// The OUTER boundary is a Noise transport message. Noise carries no length and
// no sequence number: two concatenated messages, or half of one, fail to
// authenticate and take the session down with them, permanently. So exactly one
// Noise message travels in exactly one WebSocket binary frame, and WebSocket —
// which is message-oriented, not a byte stream — keeps that boundary for us.
// The relay forwards binary frames verbatim, so the boundary survives the
// splice too. That is the whole of the outer framing, and writing it down is
// most of the work of getting it right.
//
// The INNER boundary is an application message, which is not bounded by 65535
// bytes. A peer speaks the same newline-delimited JSON the CLI socket speaks —
// that is what makes a teammate a transport onto the existing catalogue rather
// than a protocol of its own — and one of those lines can be longer than a
// single Noise message. So the encrypted stream is treated as a byte stream and
// cut into chunks that fit, with the receiver reassembling by looking for the
// newline the protocol already delimits with.
//
// Chunking does not need a length prefix precisely because the outer boundary
// is already exact: bytes arrive in the order they were sent, whole, or the
// session is over. A length prefix here would be a second mechanism for a
// property Noise already guarantees.

import { MAX_PLAINTEXT_LEN, type PeerSession } from '../../shared/peer'
import { createFrameDecoder } from '../../shared/protocol'

/**
 * The largest plaintext one transport message can carry. Kept a little under
 * the ceiling so a future prologue or header has somewhere to go without
 * changing how a peer that has not been rebuilt cuts its chunks.
 */
export const CHUNK_BYTES = MAX_PLAINTEXT_LEN - 64

/**
 * One line of NDJSON as a sequence of Noise transport messages.
 *
 * A line that fits is one message, which is the ordinary case: a presence
 * snapshot for a busy machine is a few kilobytes.
 */
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

/**
 * The receiving half: decrypt, append, hand back whole JSON values.
 *
 * The decoder is the protocol's own, so a peer and a CLI client are parsed by
 * one implementation and cannot disagree about what a frame is.
 */
export function createLineReader(session: PeerSession): LineReader {
  const decode = createFrameDecoder()
  const text = new TextDecoder()
  return {
    push: (message) => {
      const plaintext = session.decrypt(message)
      // `stream: true` because a multi-byte character can straddle two chunks,
      // and half of one decoded eagerly becomes U+FFFD that never comes back.
      return decode(text.decode(plaintext, { stream: true }))
    }
  }
}
