// `teamree mcp` as Codex drives it: newline-delimited JSON-RPC on stdio, answered
// through a real socket to a stub runtime. Transcripts, not mocks.

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyProjectContext } from '../shared/memory.js'
import { serveMcp } from './mcp.js'
import { startStubRuntime, StubError, type StubHandler } from './stub-runtime.js'
import { connectRuntime } from './transport.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const BUNDLE = 'goal: Fix login redirect\nsibling rate-limits: Add per-user rate limits\n  conflict: src/auth.ts'

const runtime: StubHandler = (method, params) => {
  const given = params as Record<string, unknown>
  if (method === 'project.context') return { ...emptyProjectContext(given.worktreeId as string), text: BUNDLE }
  if (method === 'memory.check') {
    return { worktreeId: 'wt_1', path: 'src/free.ts', siblings: [], text: '' }
  }
  if (method === 'memory.note') return { id: 'note_1', ...given }
  throw new StubError('not_found', method)
}

/** Sends each line, then closes stdin, and hands back every reply the server wrote. */
async function transcript(lines: readonly unknown[], handler: StubHandler = runtime) {
  const stub = await startStubRuntime(handler)
  cleanups.push(() => stub.close())
  const client = await connectRuntime({ endpoint: stub.endpoint, timeoutMs: 2000 })
  cleanups.push(() => client.close())
  const input = new PassThrough()
  const written: string[] = []
  const served = serveMcp(input, (line) => written.push(line), {
    call: client.call,
    worktreeId: 'wt_1',
    terminalId: 't_1'
  })
  for (const line of lines) input.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
  input.end()
  await served
  for (const line of written) expect(line.endsWith('\n') && !line.slice(0, -1).includes('\n')).toBe(true)
  return { replies: written.map((line) => JSON.parse(line) as Record<string, unknown>), stub }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'codex-mcp-client', version: '0.146.0' }
  }
}
const call = (id: number, name: string, args: object = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args }
})

describe('teamree mcp', () => {
  it('initializes, lists two tools and answers both through the runtime', async () => {
    const { replies, stub } = await transcript([
      INITIALIZE,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      call(2, 'siblings'),
      call(3, 'siblings', { path: 'src/free.ts' }),
      call(4, 'note', { text: 'Limiter state lives in postgres', paths: ['src/limiter/**'] })
    ])

    expect(replies[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'teamree', version: expect.any(String) }
      }
    })
    // A notification gets no reply, so the next one is tools/list.
    const list = replies[1] as { id: number; result: { tools: Array<{ name: string; inputSchema: object }> } }
    expect(list.id).toBe(1)
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['siblings', 'note'])
    for (const tool of list.result.tools) expect(tool.inputSchema).toMatchObject({ type: 'object' })

    expect(replies[2]).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: BUNDLE }] } })
    expect(replies[3]).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'No overlap.' }] } })
    expect(replies[4]).toEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'noted note_1' }] } })
    expect(replies).toHaveLength(5)

    expect(stub.received.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'project.context', params: { worktreeId: 'wt_1', format: 'text' } },
      { method: 'memory.check', params: { worktreeId: 'wt_1', path: 'src/free.ts' } },
      {
        method: 'memory.note',
        params: {
          worktreeId: 'wt_1',
          kind: 'decision',
          text: 'Limiter state lives in postgres',
          paths: ['src/limiter/**'],
          terminalId: 't_1'
        }
      }
    ])
  })

  it('offers its own protocol version when the client asks for one it does not know', async () => {
    const { replies } = await transcript([
      { ...INITIALIZE, params: { ...INITIALIZE.params, protocolVersion: '1999-01-01' } }
    ])
    expect((replies[0] as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18')
  })

  it('says there is no overlap rather than sending nothing', async () => {
    const { replies } = await transcript([call(1, 'siblings')], (method, params) =>
      method === 'project.context' ? emptyProjectContext((params as { worktreeId: string }).worktreeId) : null
    )
    expect(replies[0]).toMatchObject({ result: { content: [{ type: 'text', text: 'No overlap.' }] } })
  })

  it('answers a bad tool call as a tool error, and a runtime failure too, and keeps serving', async () => {
    const { replies } = await transcript(
      [
        call(1, 'note', {}),
        call(2, 'note', { text: 'x'.repeat(501) }),
        call(3, 'siblings'),
        { jsonrpc: '2.0', id: 4, method: 'ping' }
      ],
      () => {
        throw new StubError('internal', 'the runtime fell over')
      }
    )
    expect(replies[0]).toMatchObject({ id: 1, result: { isError: true } })
    expect(replies[1]).toMatchObject({ id: 2, result: { isError: true } })
    expect(replies[2]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'the runtime fell over' }], isError: true }
    })
    expect(replies[3]).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
  })

  it('speaks JSON-RPC errors for an unknown tool, an unknown method and a line that is not JSON', async () => {
    const { replies } = await transcript([
      call(1, 'delete_everything'),
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      'not json',
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }
    ])
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool: delete_everything' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found: resources/list' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
    ])
  })
})
