// The provider process against a stand-in that speaks the protocol, or breaks it on purpose.

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderProcess, type ProviderEventLine, type ProviderState } from './providerProcess'

const STUB = fileURLToPath(new URL('./fixtures/stubProvider.mjs', import.meta.url))
const query = { projectId: 'p1', worktreeId: 'w1', budgetTokens: 500 }
const running: ProviderProcess[] = []

function stub(mode: string, options: { greet?: () => Promise<ProviderEventLine[]>; startTimeoutMs?: number } = {}) {
  const states: ProviderState[] = []
  const provider = new ProviderProcess({
    name: 'stub',
    command: process.execPath,
    args: [STUB, mode],
    app: 'teamree test',
    timeoutMs: 150,
    onState: (state) => states.push(state),
    ...options
  })
  running.push(provider)
  return { provider, states }
}

async function until(test: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function started(provider: ProviderProcess): Promise<void> {
  provider.start()
  await until(() => provider.state !== 'starting')
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((provider) => provider.stop()))
})

describe('a context provider process', () => {
  it('says hello, hears the ledger replayed, and answers context and walkers', async () => {
    const greet = async (): Promise<ProviderEventLine[]> => [
      { projectId: 'p1', event: { type: 'project', project: { id: 'p1', name: 'r', path: '/r', baseRef: 'main' } } },
      { projectId: 'p1', event: { type: 'worktreeRemoved', worktreeId: 'w9' } }
    ]
    const { provider, states } = stub('good', { greet })
    await started(provider)
    expect(provider.state).toBe('running')
    expect(provider.version).toBe('9.9.9')
    expect(states).toEqual(['starting', 'running'])

    provider.observe('p1', { type: 'landed', worktreeId: 'w1', into: 'main' })
    const answer = await provider.ask('p1', { walker: 'why_file', path: 'a.ts' })
    expect(answer).toMatchObject({ walker: 'why_file', path: 'landed', changes: 3 })
    const context = await provider.context(query)
    expect(context.related?.[0]?.name).toBe('rate-limit-the-api')
  })

  it('refuses calls while starting or off, without counting them', async () => {
    const { provider } = stub('good')
    await expect(provider.context(query)).rejects.toThrow('off')
    provider.start()
    await expect(provider.context(query)).rejects.toThrow('starting')
    await until(() => provider.state === 'running')
    await expect(provider.context(query)).resolves.toBeDefined()
  })

  it('turns off after three timeouts in a row and stays off', async () => {
    const { provider, states } = stub('slow')
    await started(provider)
    for (let call = 0; call < 3; call += 1) await expect(provider.context(query)).rejects.toThrow('timeout')
    expect(provider.state).toBe('failed')
    expect(provider.detail).toBe('timeout')
    await expect(provider.context(query)).rejects.toThrow('off')
    expect(states.at(-1)).toBe('failed')
  })

  it('forgives a failure once a call succeeds', async () => {
    const { provider } = stub('slow-after-one')
    await started(provider)
    await expect(provider.ask('p1', { walker: 'related_work', worktreeId: 'w1' })).resolves.toBeDefined()
    await expect(provider.context(query)).rejects.toThrow('timeout')
    await expect(provider.context(query)).rejects.toThrow('timeout')
    expect(provider.state).toBe('running')
  })

  it('counts unreadable lines, error replies and answers that fail validation', async () => {
    for (const mode of ['garbage', 'refuses', 'bad-answer']) {
      const { provider } = stub(mode)
      await started(provider)
      for (let call = 0; call < 3; call += 1) {
        await expect(
          provider.ask('p1', { walker: 'conflict_risk', worktreeId: 'w1', paths: ['a.ts'] })
        ).rejects.toThrow()
      }
      await until(() => provider.state === 'failed')
    }
  })

  it('starts again after a crash, until the third', async () => {
    const { provider } = stub('crash')
    await started(provider)
    await expect(provider.context(query)).rejects.toThrow('exited 1')
    expect(provider.detail).toBe('exited 1: boom')
    await until(() => provider.state === 'running')
    await expect(provider.context(query)).rejects.toThrow()
    await until(() => provider.state === 'running')
    await expect(provider.context(query)).rejects.toThrow()
    await until(() => provider.state === 'failed')
  })

  it('never runs one that will not say hello, or speaks another protocol', async () => {
    const mute = stub('mute', { startTimeoutMs: 200 }).provider
    await started(mute)
    expect(mute.state).toBe('failed')
    const old = stub('old').provider
    await started(old)
    expect([old.state, old.detail]).toEqual(['failed', 'speaks protocol 99'])
  })

  it('treats a line past the limit as a failure and ends the process', async () => {
    const { provider } = stub('long')
    await started(provider)
    await expect(provider.context(query)).rejects.toThrow()
  })

  it('shrugs off noise before hello as one failure', async () => {
    const { provider } = stub('noisy')
    await started(provider)
    expect(provider.state).toBe('running')
    await expect(provider.context(query)).resolves.toBeDefined()
  })

  it('stops the process and a fresh start clears the failures', async () => {
    const { provider } = stub('slow')
    await started(provider)
    for (let call = 0; call < 3; call += 1) await expect(provider.context(query)).rejects.toThrow()
    expect(provider.state).toBe('failed')
    await started(provider)
    expect(provider.state).toBe('running')
    await provider.stop()
    expect(provider.state).toBe('stopped')
  })

  it('fails a command that does not exist without throwing', async () => {
    const provider = new ProviderProcess({ name: 'none', command: '/nonexistent/teamree-jac', app: 't' })
    running.push(provider)
    provider.start()
    await until(() => provider.state === 'failed')
    expect(provider.detail).toContain('ENOENT')
  })
})
