// A refused teamwork push says so once, in one line, and the notice goes when a push lands.

import { expect, it, vi } from 'vitest'
import type { TeamworkPublish } from '@shared/entities'

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

const published = (push: TeamworkPublish['push']): TeamworkPublish => ({
  projectId: 'p1',
  files: ['.teamree/members/sam.pub'],
  commit: null,
  remote: 'origin',
  branch: 'main',
  push,
  at: 0
})

const rejected = published({
  ok: false,
  kind: 'rejected',
  error: '! [rejected] main -> main (fetch first)\nhint: Updates were rejected',
  advice: 'Push rejected: origin is ahead'
})

/** Answers the push with `result`, a pull with success, and every read with nothing. */
function runtime(result: TeamworkPublish): void {
  call.mockImplementation((method: string) => {
    if (method === 'teamwork.publish') return Promise.resolve(result)
    if (method === 'teamwork.pull') {
      return Promise.resolve({ projectId: 'p1', ok: true, moved: true, problem: null, detail: null })
    }
    return Promise.resolve(null)
  })
}

it('shows one line for a rejected push, keeps only one, and clears it when a push lands', async () => {
  call.mockReset()
  useWorkspaceStore.setState({ ...INITIAL, notices: [] })
  const errors = (): string[] =>
    useWorkspaceStore
      .getState()
      .notices.filter((notice) => notice.tone === 'error')
      .map((notice) => notice.text)

  runtime(rejected)
  await useWorkspaceStore.getState().publishTeamwork('p1')
  await useWorkspaceStore.getState().publishTeamwork('p1')
  expect(errors()).toEqual(['Push rejected: origin is ahead'])

  runtime(published({ ok: true, upstream: 'origin/main', setUpstream: false, alreadyUpToDate: false }))
  await useWorkspaceStore.getState().publishTeamwork('p1', { pull: true })
  expect(call).toHaveBeenCalledWith('teamwork.pull', { projectId: 'p1' })
  expect(errors()).toEqual([])
})
