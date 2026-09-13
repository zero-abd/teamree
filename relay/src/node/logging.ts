// The one piece of logging that has to know which runtime it is in: a keyed,
// synchronous, irreversible hash. Node has HMAC-SHA256 synchronously; an edge
// runtime would supply its own here and change nothing else.

import { createHmac, randomBytes } from 'node:crypto'
import { createLogger, type Logger, type LoggerOptions } from '../core/log.js'

export function createNodeLogger(options: Omit<LoggerOptions, 'ref'> = {}): Logger {
  // A fresh key per process is what stops a ref outliving the run it was
  // written in, and what makes a log of refs useless to anyone who steals it.
  const key = randomBytes(32)
  return createLogger({
    ...options,
    // Recomputed rather than cached: a cache keyed by secrets is a table of
    // secrets, and this runs a handful of times per connection.
    ref: (secret) => createHmac('sha256', key).update(secret).digest('hex').slice(0, 12)
  })
}
