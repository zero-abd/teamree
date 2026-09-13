// The Workers runtime has no synchronous keyed hash — WebCrypto's HMAC is a
// promise, and logging is not a place to await. So refs here are random labels
// handed out on first sight and remembered for as long as the object is in
// memory, which is irreversible in the way that matters: the label is not
// derived from the secret at all.
//
// The table is bounded and small because one of these serves one rendezvous.

import { createLogger, type Logger, type LoggerOptions } from '../core/log.js'
import { randomHex } from '../core/random.js'

const MAX_LABELS = 32

export function createWorkersLogger(options: Omit<LoggerOptions, 'ref'> = {}): Logger {
  const labels = new Map<string, string>()
  return createLogger({
    ...options,
    ref: (secret) => {
      const existing = labels.get(secret)
      if (existing !== undefined) return existing
      // Past the cap, stop naming things rather than grow: a missing ref costs
      // an operator a correlation, and an unbounded map costs everyone.
      if (labels.size >= MAX_LABELS) return '-'
      const label = randomHex(6)
      labels.set(secret, label)
      return label
    }
  })
}
