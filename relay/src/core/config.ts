// Every knob is an env var with a safe default; a bad value fails startup by name, since a silent
// fallback leaves an operator believing a limit is enforced.

export type RelayConfig = {
  host: string
  port: number
  /** The single WebSocket path. Anything else gets a 404 from the HTTP server. */
  path: string

  /** Admission control, container host only: the Worker host has no process-wide view (see `rendezvousPair.ts`). */
  maxConnections: number
  maxConnectionsPerAddress: number
  maxConnectionsPerAddressPerMinute: number

  /** Largest single WebSocket frame accepted, enforced before any of it is buffered. */
  maxFrameBytes: number
  maxFramesPerSecond: number
  maxBytesPerSecond: number
  /** How far a peer's send queue may run ahead of its reading before it is closed; the memory bound. */
  maxBufferedBytes: number

  helloTimeoutMs: number
  /** How long an unpaired peer may park. 0 parks until the socket dies. */
  pairTimeoutMs: number
  /** How long a paired session may show no life at all, keepalives included. 0 disables. */
  idleTimeoutMs: number
  keepaliveIntervalMs: number
  shutdownGraceMs: number

  /** Reverse proxies in front. 0 trusts the socket address, which a client cannot forge. */
  trustedProxyHops: number
  /** Off by default: the relay should learn as little as it can get away with. */
  logClientAddress: boolean
  /** When set, /healthz needs `Authorization: Bearer <token>`. */
  healthToken: string | null
}

export const defaultConfig: RelayConfig = {
  host: '0.0.0.0',
  port: 8787,
  path: '/v1/relay',

  maxConnections: 512,
  maxConnectionsPerAddress: 32,
  maxConnectionsPerAddressPerMinute: 60,

  maxFrameBytes: 256 * 1024,
  maxFramesPerSecond: 200,
  maxBytesPerSecond: 4 * 1024 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,

  helloTimeoutMs: 10_000,
  pairTimeoutMs: 10 * 60_000,
  idleTimeoutMs: 10 * 60_000,
  keepaliveIntervalMs: 30_000,
  shutdownGraceMs: 5_000,

  trustedProxyHops: 0,
  logClientAddress: false,
  healthToken: null
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>

function readInteger(env: Env, name: string, fallback: number, minimum: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  const value = Number(raw)
  if (value < minimum) throw new ConfigError(`${name} must be at least ${minimum}, got ${value}`)
  return value
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  throw new ConfigError(`${name} must be one of 1, 0, true, false, got ${JSON.stringify(raw)}`)
}

export function configFromEnv(env: Env = process.env): RelayConfig {
  const path = env.RELAY_PATH ?? defaultConfig.path
  if (!path.startsWith('/')) throw new ConfigError(`RELAY_PATH must start with /, got ${JSON.stringify(path)}`)

  const config: RelayConfig = {
    host: env.RELAY_HOST ?? defaultConfig.host,
    port: readInteger(env, 'RELAY_PORT', defaultConfig.port, 0),
    path,

    maxConnections: readInteger(env, 'RELAY_MAX_CONNECTIONS', defaultConfig.maxConnections, 2),
    maxConnectionsPerAddress: readInteger(
      env,
      'RELAY_MAX_CONNECTIONS_PER_ADDRESS',
      defaultConfig.maxConnectionsPerAddress,
      1
    ),
    maxConnectionsPerAddressPerMinute: readInteger(
      env,
      'RELAY_MAX_CONNECTIONS_PER_ADDRESS_PER_MINUTE',
      defaultConfig.maxConnectionsPerAddressPerMinute,
      1
    ),

    maxFrameBytes: readInteger(env, 'RELAY_MAX_FRAME_BYTES', defaultConfig.maxFrameBytes, 1024),
    maxFramesPerSecond: readInteger(env, 'RELAY_MAX_FRAMES_PER_SECOND', defaultConfig.maxFramesPerSecond, 1),
    maxBytesPerSecond: readInteger(env, 'RELAY_MAX_BYTES_PER_SECOND', defaultConfig.maxBytesPerSecond, 1024),
    maxBufferedBytes: readInteger(env, 'RELAY_MAX_BUFFERED_BYTES', defaultConfig.maxBufferedBytes, 64 * 1024),

    helloTimeoutMs: readInteger(env, 'RELAY_HELLO_TIMEOUT_MS', defaultConfig.helloTimeoutMs, 100),
    pairTimeoutMs: readInteger(env, 'RELAY_PAIR_TIMEOUT_MS', defaultConfig.pairTimeoutMs, 0),
    idleTimeoutMs: readInteger(env, 'RELAY_IDLE_TIMEOUT_MS', defaultConfig.idleTimeoutMs, 0),
    keepaliveIntervalMs: readInteger(env, 'RELAY_KEEPALIVE_INTERVAL_MS', defaultConfig.keepaliveIntervalMs, 1000),
    shutdownGraceMs: readInteger(env, 'RELAY_SHUTDOWN_GRACE_MS', defaultConfig.shutdownGraceMs, 0),

    trustedProxyHops: readInteger(env, 'RELAY_TRUSTED_PROXY_HOPS', defaultConfig.trustedProxyHops, 0),
    logClientAddress: readBoolean(env, 'RELAY_LOG_CLIENT_ADDRESS', defaultConfig.logClientAddress),
    healthToken: env.RELAY_HEALTH_TOKEN ?? defaultConfig.healthToken
  }

  // Below one frame, a peer would be closed for a frame it never had a chance to read.
  if (config.maxBufferedBytes < config.maxFrameBytes) {
    throw new ConfigError('RELAY_MAX_BUFFERED_BYTES must be at least RELAY_MAX_FRAME_BYTES')
  }
  if (config.maxBytesPerSecond < config.maxFrameBytes) {
    throw new ConfigError('RELAY_MAX_BYTES_PER_SECOND must be at least RELAY_MAX_FRAME_BYTES')
  }

  return config
}
