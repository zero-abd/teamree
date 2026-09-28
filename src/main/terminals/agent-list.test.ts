import { beforeEach, describe, expect, it, vi } from 'vitest'

const reset = vi.fn()
const find = vi.fn(() => [])

vi.mock('./shell-environment', async (original) => ({
  ...(await original<typeof import('./shell-environment')>()),
  resetLoginShellPathCache: () => reset()
}))
vi.mock('./agent-discovery', async (original) => ({
  ...(await original<typeof import('./agent-discovery')>()),
  findInstalledAgents: () => find()
}))

const { createTerminalService } = await import('./method-handlers')

beforeEach(() => {
  reset.mockClear()
  find.mockClear()
})

// An installer adds its directory to the profile; the cached login PATH would never see it.
describe('agent.list', () => {
  it('asks the login shell again when told the answer may be stale', async () => {
    await createTerminalService().handlers['agent.list']({ fresh: true })
    expect(reset).toHaveBeenCalledOnce()
    expect(find).toHaveBeenCalledOnce()
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(find.mock.invocationCallOrder[0] ?? 0)
  })

  it('keeps the cached login PATH otherwise', async () => {
    await createTerminalService().handlers['agent.list']({ versions: true })
    expect(reset).not.toHaveBeenCalled()
  })
})
