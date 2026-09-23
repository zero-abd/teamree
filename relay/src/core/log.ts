// One JSON object per line. Never in it: payload bytes in any form, the
// rendezvous token (a shared secret), or a client address unless asked. Tokens
// and addresses appear as refs keyed per process; the host supplies the keyed hash.

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
