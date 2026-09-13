// One JSON object per line, for a process whose whole job is to be boring. The
// interesting part of a logger here is what may not appear in it:
//
//   - no payload bytes, ever, in any form, not even truncated or hex-encoded;
//   - no rendezvous token, because it is a shared secret and an operator who
//     kept a log of them could knock over any pairing in it;
//   - no client address unless the operator explicitly asks, because the relay
//     is supposed to learn as little as it can get away with.
//
// Correlation still has to work, so tokens and addresses appear as refs: short
// ids the runtime derives under a per-process key. Two connections with the same
// rendezvous share a ref within one run, and no ref survives a restart or can be
// turned back into what produced it. The derivation is supplied by the host,
// because a synchronous keyed hash is the one thing runtimes disagree about.

export type LogValue = string | number | boolean | undefined
export type LogFields = Record<string, LogValue>

export type Logger = {
  info: (event: string, fields?: LogFields) => void
  warn: (event: string, fields?: LogFields) => void
  error: (event: string, fields?: LogFields) => void
  /** Stable within this process, meaningless outside it, irreversible either way. */
  ref: (secret: string) => string
}

export type LoggerOptions = {
  ref: (secret: string) => string
  write?: (line: string) => void
  now?: () => number
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => console.log(line))
  const now = options.now ?? (() => Date.now())

  const emit = (level: string, event: string, fields: LogFields = {}): void => {
    const record: Record<string, LogValue> = { ts: new Date(now()).toISOString(), level, event }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) record[key] = value
    }
    write(JSON.stringify(record))
  }

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    ref: options.ref
  }
}
