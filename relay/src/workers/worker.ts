// The Cloudflare entry point, the only relay file naming a Cloudflare type: health check, rendezvous
// name to Durable Object, hand over the upgrade. Every rule lives in core, shared with the Node host.

import { configFromEnv } from '../core/config.js'
import { RendezvousPair, type PairEnvironment, type PairSocket } from './rendezvousPair.js'

export type Env = PairEnvironment & {
  RENDEZVOUS_PAIR: DurableObjectNamespace
}

/** The name in the URL is a SHA-256, so it is 64 hex characters or it is wrong. */
const RENDEZVOUS_NAME = /^[0-9a-f]{64}$/

export class RelayPair implements DurableObject {
  private readonly pair: RendezvousPair
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.pair = new RendezvousPair(state as unknown as ConstructorParameters<typeof RendezvousPair>[0], env, {
      autoResponse: (request, response) => new WebSocketRequestResponsePair(request, response)
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const origin = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    // Anyone may address any object; the object bounds what it holds and makes room rather than refusing.
    // A client cannot read this status, so ordinary teammates must never meet it.
    if (!this.pair.accept(server as unknown as PairSocket, origin)) {
      return new Response('this rendezvous already has as many connections as it can hold', { status: 503 })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.pair.onMessage(socket as unknown as PairSocket, message)
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    await this.pair.onClose(socket as unknown as PairSocket, code)
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    await this.pair.onError(socket as unknown as PairSocket, error)
  }

  async alarm(): Promise<void> {
    await this.pair.onAlarm()
    void this.state
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = configFromEnv(env)
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/healthz') {
      // Thinner than the Node host's: a Worker has no global view, and building one would collect what this relay avoids.
      return new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      })
    }

    const prefix = `${config.path}/`
    if (!url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 })

    // A hash of the rendezvous: URLs reach logs, and the token would let a reader claim the pairing.
    const name = url.pathname.slice(prefix.length)
    if (!RENDEZVOUS_NAME.test(name)) return new Response('not found', { status: 404 })

    const stub = env.RENDEZVOUS_PAIR.get(env.RENDEZVOUS_PAIR.idFromName(name))
    return stub.fetch(request)
  }
}
