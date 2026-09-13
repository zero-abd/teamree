// The entrypoint. Config comes from the environment, logs go to stdout, and the
// only interesting behaviour is that SIGTERM ends sessions politely instead of
// letting the container runtime cut them mid-frame.

import { ConfigError, configFromEnv } from '../core/config.js'
import { createNodeLogger } from './logging.js'
import { startRelay } from './server.js'

const log = createNodeLogger()

async function main(): Promise<void> {
  const config = configFromEnv()
  const relay = await startRelay({ config, log })

  let stopping = false
  const stop = (signal: string): void => {
    // A second signal means whoever sent the first has run out of patience, and
    // arguing with them by ignoring it would be worse than a hard exit.
    if (stopping) {
      log.warn('relay.forced', { signal })
      process.exit(1)
    }
    stopping = true
    log.info('relay.stopping', { signal })
    relay.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error('relay.stopFailed', { reason: error instanceof Error ? error.message : String(error) })
        process.exit(1)
      }
    )
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    log.error('relay.misconfigured', { reason: error.message })
    process.exit(2)
  }
  log.error('relay.startFailed', { reason: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
