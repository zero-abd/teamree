import { afterEach, describe, expect, it } from 'vitest'
import { CliError, NoRuntimeError, RuntimeCallError } from './exit.js'
import { NO_REPLY, StubError, startStubRuntime, stubEndpointPath, type StubRuntime } from './stub-runtime.js'
import { classifyFrame, connectRuntime, describeConnectFailure, type RuntimeClient } from './transport.js'

const open: Array<{ close: () => Promise<void> | void }> = []

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

async function withStub(handler: Parameters<typeof startStubRuntime>[0], timeoutMs = 2000): Promise<{ stub: StubRuntime; client: RuntimeClient }> {
  const stub = await startStubRuntime(handler)
  open.push(stub)
  const client = await connectRuntime({ endpoint: stub.endpoint, timeoutMs })
  open.push({ close: () => client.close() })
  return { stub, client }
}

describe('classifyFrame', () => {
  it('tells responses, stream events and rubbish apart', () => {
    expect(classifyFrame({ id: 'a', ok: true, result: 1 })).toMatchObject({ id: 'a' })
    expect(classifyFrame({ stream: 's', event: {} })).toMatchObject({ stream: 's' })
    expect(classifyFrame({ hello: true })).toBeNull()
    expect(classifyFrame(null)).toBeNull()
    expect(classifyFrame(7)).toBeNull()
  })
})

describe('connectRuntime', () => {
  it('round-trips a call over a real socket', async () => {
    const { stub, client } = await withStub((method, params) => {
      expect(method).toBe('worktree.list')
      return [{ id: 'w1', name: 'fix', params }]
    })
    const result = await client.call('worktree.list', { projectId: 'p1' })
    expect(result).toEqual([{ id: 'w1', name: 'fix', params: { projectId: 'p1' } }])
    expect(stub.received[0]).toMatchObject({ method: 'worktree.list', params: { projectId: 'p1' } })
    expect(stub.received[0]?.id).toMatch(/^cli-/)
  })

  it('correlates replies by id, not by arrival order', async () => {
    const held: Array<{ id: string; value: string }> = []
    const { client } = await withStub((method, _params, context) => {
      held.push({ id: context.id, value: method })
      if (held.length === 2) {
        // Answer in reverse, so only id correlation can keep these straight.
        for (const entry of [...held].reverse()) context.respond(entry.id, entry.value)
      }
      return NO_REPLY
    })
    const [first, second] = await Promise.all([client.call('project.list', {}), client.call('terminal.list', {})])
    expect(first).toBe('project.list')
    expect(second).toBe('terminal.list')
  })

  it('turns an error response into a failure carrying its protocol code', async () => {
    const { client } = await withStub(() => {
      throw new StubError('not_found', 'no such worktree')
    })
    await expect(client.call('worktree.status', { worktreeId: 'nope' })).rejects.toBeInstanceOf(RuntimeCallError)
    await client.call('worktree.status', { worktreeId: 'nope' }).catch((error: RuntimeCallError) => {
      expect(error.code).toBe('not_found')
      expect(error.exitCode).toBe(1)
      expect(error.message).toContain('worktree.status')
    })
  })

  it('gives up on a request that is never answered', async () => {
    const { client } = await withStub(() => NO_REPLY, 60)
    await client.call('status.get', {}).then(
      () => expect.unreachable('should have timed out'),
      (error: CliError) => {
        expect(error.code).toBe('timeout')
        expect(error.exitCode).toBe(1)
        expect(error.hint).toContain('--timeout')
      }
    )
  })

  it('routes stream events to their subscription, including ones that arrive first', async () => {
    const { stub, client } = await withStub((method, _params, context) => {
      if (method === 'terminal.subscribe') {
        // Emitted before this call's own response, exercising the event buffer.
        context.emit('sub-1', { type: 'data', data: 'early' })
        return { subscription: 'sub-1' }
      }
      if (method === 'unsubscribe') return { unsubscribed: true }
      context.emit('sub-1', { type: 'data', data: 'later' })
      return { data: '' }
    })

    const seen: unknown[] = []
    const subscription = await client.subscribe('terminal.subscribe', { terminalId: 't1' }, (event) => seen.push(event))
    expect(subscription.id).toBe('sub-1')
    expect(seen).toEqual([{ type: 'data', data: 'early' }])

    await client.call('terminal.read', { terminalId: 't1' })
    expect(seen).toHaveLength(2)

    await subscription.unsubscribe()
    expect(stub.received.map((entry) => entry.method)).toContain('unsubscribe')
  })

  it('rejects a subscription the runtime did not identify', async () => {
    const { client } = await withStub(() => ({ nope: true }))
    await expect(client.subscribe('terminal.subscribe', { terminalId: 't1' }, () => {})).rejects.toThrow(/subscription id/)
  })

  it('reports a dead endpoint as no runtime running', async () => {
    await connectRuntime({ endpoint: stubEndpointPath(), timeoutMs: 500 }).then(
      () => expect.unreachable('should not connect'),
      (error: CliError) => {
        expect(error).toBeInstanceOf(NoRuntimeError)
        expect(error.exitCode).toBe(3)
        expect(error.hint).toMatch(/desktop app/)
      }
    )
  })

  it('fails pending calls when the runtime hangs up', async () => {
    const stub = await startStubRuntime(() => NO_REPLY)
    const client = await connectRuntime({ endpoint: stub.endpoint, timeoutMs: 2000 })
    const pending = client.call('status.get', {})
    await stub.close()
    await pending.then(
      () => expect.unreachable('should have failed'),
      (error: CliError) => {
        expect(error.exitCode).toBe(1)
        expect(error.code).toMatch(/connection_(closed|lost)/)
      }
    )
    client.close()
  })

  it('classifies connect errnos', () => {
    expect(describeConnectFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), '/s').exitCode).toBe(3)
    expect(describeConnectFailure(Object.assign(new Error('x'), { code: 'EPIPE' }), '/s').exitCode).toBe(1)
  })
})
