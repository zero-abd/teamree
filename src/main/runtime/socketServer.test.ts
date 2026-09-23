// End-to-end over a real unix socket: the CLI's whole experience of the runtime
// is this transport, so it is tested against actual connections rather than mocks.

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Params } from '../../shared/methods'
import { createFrameDecoder, type Response } from '../../shared/protocol'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher } from './dispatcher'
import { registerHandlers } from './handlers/registerHandlers'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { ENDPOINT_MODE, startSocketServer, type RuntimeSocketServer } from './socketServer'
import { SubscriptionHub } from './subscriptionHub'

type Client = {
  socket: Socket
  frames: unknown[]
  send: (line: string) => void
  waitFor: (count: number) => Promise<void>
}

function openClient(endpoint: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    const decode = createFrameDecoder()
    const frames: unknown[] = []
    socket.setEncoding('utf8')
    socket.on('data', (chunk: Buffer | string) => {
      frames.push(...decode(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
    })
    socket.once('error', reject)
    socket.once('connect', () =>
      resolve({
        socket,
        frames,
        send: (line) => socket.write(line),
        waitFor: async (count) => {
          const deadline = Date.now() + 2000
          while (frames.length < count) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} frames`)
            await new Promise((tick) => setTimeout(tick, 5))
          }
        }
      })
    )
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((tick) => setTimeout(tick, 5))
  }
}

// Unix domain sockets only, skipped rather than adapted on win32. Nothing has
// ever bound a named pipe or run the `listenWithStaleRecovery` branch that
// refuses to unlink one; the app ships macOS-only (see ROADMAP.md).
describe.skipIf(process.platform === 'win32')('socket server', () => {
  let directory: string
  let endpoint: string
  let hub: SubscriptionHub
  let server: RuntimeSocketServer

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-socket-'))
    endpoint = join(directory, 'runtime.sock')
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    hub = new SubscriptionHub()
    const context = createRuntimeContext({ version: '1.2.3', store, subscriptions: hub, endpoint })
    const registry = new MethodRegistry(context)
    registerHandlers(registry)
    // A stand-in for the streams the terminal handlers will register later.
    registry.register('terminal.subscribe', Params.terminalSubscribe, (params, call) => {
      const subscription = hub.subscribe(call.connectionId, (channel) => {
        const timer = setInterval(() => channel.emit({ type: 'data', data: params.terminalId }), 5)
        return () => clearInterval(timer)
      })
      return { subscription }
    })
    server = await startSocketServer({ endpoint, dispatch: createDispatcher(registry), subscriptions: hub })
  })

  afterEach(async () => {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('answers two requests arriving in one chunk', async () => {
    const client = await openClient(endpoint)
    const chunk = `${JSON.stringify({ id: '1', method: 'status.get', params: {} })}\n${JSON.stringify({ id: '2', method: 'nope', params: {} })}\n`
    client.send(chunk)
    await client.waitFor(2)

    // Responses are correlated by id, never by arrival order.
    const byId = new Map((client.frames as Response[]).map((frame) => [frame.id, frame]))
    expect(byId.get('1')).toMatchObject({ ok: true, result: { version: '1.2.3', endpoint } })
    expect(byId.get('2')).toMatchObject({ ok: false, error: { code: 'unknown_method' } })
    client.socket.destroy()
  })

  it('serves concurrent clients independently', async () => {
    const [one, two] = await Promise.all([openClient(endpoint), openClient(endpoint)])
    // The server accepts a beat after the client's connect resolves.
    await waitUntil(() => server.connectionCount() === 2)

    one.send(`${JSON.stringify({ id: 'a', method: 'status.get' })}\n`)
    // A deliberately unknown method, so this asserts per-connection routing.
    two.send(`${JSON.stringify({ id: 'b', method: 'nope.nope', params: {} })}\n`)
    await Promise.all([one.waitFor(1), two.waitFor(1)])

    expect(one.frames[0]).toMatchObject({ id: 'a', ok: true })
    expect(two.frames[0]).toMatchObject({ id: 'b', ok: false, error: { code: 'unknown_method' } })
    one.socket.destroy()
    two.socket.destroy()
  })

  it('pushes stream frames and tears the stream down with the connection', async () => {
    const client = await openClient(endpoint)
    client.send(`${JSON.stringify({ id: 's', method: 'terminal.subscribe', params: { terminalId: 't1' } })}\n`)
    await client.waitFor(2)

    const response = client.frames[0] as Response
    expect(response.ok).toBe(true)
    expect(client.frames[1]).toMatchObject({ event: { type: 'data', data: 't1' } })
    expect(hub.size).toBe(1)

    client.socket.destroy()
    await waitUntil(() => hub.size === 0)
  })

  it('rejects a corrupt line and hangs up', async () => {
    const client = await openClient(endpoint)
    const closed = new Promise((resolve) => client.socket.once('close', resolve))
    client.send('this is not json\n')
    await client.waitFor(1)

    expect(client.frames[0]).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    await closed
  })

  it('binds an endpoint no other account may connect to', async () => {
    // connect(2) on a unix socket is an authorisation check (the kernel asks for
    // write permission on the file). Asserted as an exact mode: 0755, what an
    // ordinary umask leaves, would pass a `& 0o022` test.
    expect((await stat(endpoint)).mode & 0o777).toBe(ENDPOINT_MODE)
  })

  it('reclaims a socket file left behind by a crashed runtime', async () => {
    await server.close()
    await writeFile(endpoint, '', 'utf8')

    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    const context = createRuntimeContext({ version: '1.2.3', store, subscriptions: hub, endpoint })
    const registry = new MethodRegistry(context)
    registerHandlers(registry)
    server = await startSocketServer({ endpoint, dispatch: createDispatcher(registry), subscriptions: hub })

    const client = await openClient(endpoint)
    client.send(`${JSON.stringify({ id: 'z', method: 'status.get' })}\n`)
    await client.waitFor(1)

    expect(client.frames[0]).toMatchObject({ id: 'z', ok: true })
    client.socket.destroy()
  })
})

// `listen` takes no mode, so without `restrictEndpoint` the endpoint's permissions
// are whatever the umask leaves — 0755 from a Finder launch, 0777 from a shell
// with `umask 000`, a socket every account on the machine may connect to.
describe.skipIf(process.platform === 'win32')('the endpoint under a permissive umask', () => {
  let directory: string
  let endpoint: string
  let server: RuntimeSocketServer
  let restore: number

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-socket-umask-'))
    endpoint = join(directory, 'runtime.sock')
    restore = process.umask(0o000)
    server = await startSocketServer({
      endpoint,
      // The transport is what is under test here, not the catalogue behind it.
      dispatch: async (raw) => ({ id: (raw as { id: string }).id, ok: true, result: {} }),
      subscriptions: new SubscriptionHub()
    })
  })

  afterEach(async () => {
    process.umask(restore)
    await server.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('is owner-only however permissive the umask the app inherited', async () => {
    expect((await stat(endpoint)).mode & 0o777).toBe(ENDPOINT_MODE)
  })

  it('is still the socket the CLI connects to and gets an answer on', async () => {
    // Shutting the door on other accounts must not shut it on this one. The CLI
    // runs as the user the app runs as; that is why 0600 is enough.
    const client = await openClient(endpoint)
    client.send(`${JSON.stringify({ id: 'q', method: 'status.get', params: {} })}\n`)
    await client.waitFor(1)

    expect(client.frames[0]).toMatchObject({ id: 'q', ok: true })
    client.socket.destroy()
  })
})
