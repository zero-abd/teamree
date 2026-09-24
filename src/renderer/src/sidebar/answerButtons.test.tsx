/** @vitest-environment jsdom */

// A click on an answer sends the keys the menu showed, with the prompt the runtime re-reads the screen for;
// one that wants typing, and one the runtime refuses, go to the pane instead.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@shared/entities'
import { onRegionRequest, type Region } from '../shell/regions'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { AnswerButtons } = await import('./AnswerButtons')

const INITIAL = useWorkspaceStore.getState()
const revealPane = vi.fn(async () => {})

const PANE: Terminal = {
  id: 't1',
  worktreeId: 'w1',
  title: 'claude',
  cwd: '/w1',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  agent: 'claude',
  screenSays: 'waiting',
  screenMenu: {
    prompt: 'abcd1234',
    choices: [
      { label: 'Yes', keys: ['\r'] },
      { label: 'Yes, All Edits', keys: ['2'] },
      { label: 'No…', keys: null }
    ]
  },
  lastOutputAt: 0
}

beforeEach(() => {
  call.mockReset()
  revealPane.mockClear()
  useWorkspaceStore.setState({ ...INITIAL, terminals: { t1: PANE }, revealPane }, true)
  render(<AnswerButtons terminalId="t1" choices={PANE.screenMenu?.choices ?? []} className="test" />)
})

const regions = (): Region[] => {
  const asked: Region[] = []
  onRegionRequest((region) => asked.push(region))
  return asked
}

describe('answering a pane from its row', () => {
  it('sends the chosen keys, naming the prompt they answer', async () => {
    call.mockResolvedValue({ written: true })
    fireEvent.click(screen.getByRole('button', { name: 'Yes, All Edits' }))
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith('terminal.write', { terminalId: 't1', data: '2', answering: 'abcd1234' })
    )
    expect(revealPane).not.toHaveBeenCalled()
  })

  it('goes to the pane for an answer that wants typing, and sends nothing', async () => {
    const asked = regions()
    fireEvent.click(screen.getByRole('button', { name: 'No…' }))
    await vi.waitFor(() => expect(asked).toEqual(['panes']))
    expect(revealPane).toHaveBeenCalledWith('w1', 't1')
    expect(call).not.toHaveBeenCalled()
  })

  it('says so in one line and goes to the pane when the screen has moved on', async () => {
    call.mockRejectedValue(new Error('terminal t1 no longer asks that'))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await vi.waitFor(() => expect(revealPane).toHaveBeenCalledWith('w1', 't1'))
    expect(useWorkspaceStore.getState().notices.map((notice) => notice.text)).toEqual(['No longer asking that'])
  })
})
