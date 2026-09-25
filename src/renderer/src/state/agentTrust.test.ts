// Settings › Agents › Trust New Worktrees, as the window holds it: on until the runtime says otherwise.

import { expect, it, vi } from 'vitest'

const call = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params) as Promise<unknown>,
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')

const INITIAL = useWorkspaceStore.getState()

function reset(): void {
  call.mockReset()
  useWorkspaceStore.setState({ ...INITIAL, notices: [] })
}

it('starts on and reads what the runtime holds', async () => {
  reset()
  expect(useWorkspaceStore.getState().trustNewWorktrees).toBe(true)
  call.mockResolvedValue({ trustNewWorktrees: false })

  await useWorkspaceStore.getState().loadAgentTrust()

  expect(call).toHaveBeenCalledWith('agents.trust', {})
  expect(useWorkspaceStore.getState().trustNewWorktrees).toBe(false)
})

it('records a change, and puts it back when the runtime could not', async () => {
  reset()
  call.mockResolvedValueOnce({ trustNewWorktrees: false })
  await useWorkspaceStore.getState().setTrustNewWorktrees(false)
  expect(call).toHaveBeenCalledWith('agents.setTrust', { trustNewWorktrees: false })
  expect(useWorkspaceStore.getState().trustNewWorktrees).toBe(false)

  call.mockRejectedValueOnce(new Error('nothing is being saved'))
  await useWorkspaceStore.getState().setTrustNewWorktrees(true)
  expect(useWorkspaceStore.getState().trustNewWorktrees).toBe(false)
  expect(useWorkspaceStore.getState().notices).toHaveLength(1)
})
