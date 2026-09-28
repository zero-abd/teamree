/** @vitest-environment jsdom */

// A machine with no coding agent: the welcome says so on first run, and Check Again clears it.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledAgent } from '@shared/entities'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const { Welcome } = await import('./Welcome')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')
const PROJECT = { id: 'p1', name: 'infra', path: '/repos/infra', baseRef: 'origin/main' }
let found: InstalledAgent[] = []

beforeEach(() => {
  found = []
  call.mockReset()
  call.mockImplementation(async (method) => {
    if (method === 'agent.list') return found
    if (method === 'cli.status') throw new Error('no cli here')
    throw new Error(`unexpected ${method}`)
  })
  useWorkspaceStore.setState({ ...INITIAL, projects: [], agents: [], agentsProbed: true, cli: null }, true)
})

afterEach(cleanup)

const panel = (): HTMLElement | null => screen.queryByRole('region', { name: 'No coding agent found' })

describe('the welcome with no agent', () => {
  it('names the harnesses to install on first run, in place of the setup row', async () => {
    render(<Welcome modifier={MAC} project={undefined} />)
    await act(async () => {})
    const shown = panel()
    if (shown === null) throw new Error('no panel')
    expect(within(shown).getByText('npm install -g @anthropic-ai/claude-code')).toBeTruthy()
    expect(shown.querySelector('svg.agent-glyph[data-agent="codex"]')).not.toBeNull()
    expect(document.querySelector('[data-setup="agents"]')).toBeNull()
  })

  it('says so beside New Task… once a project is added', async () => {
    render(<Welcome modifier={MAC} project={PROJECT} />)
    await act(async () => {})
    expect(screen.getByRole('button', { name: /New Task/ })).toBeTruthy()
    expect(panel()).not.toBeNull()
  })

  it('clears once Check Again finds one, asking the login shell afresh', async () => {
    render(<Welcome modifier={MAC} project={undefined} />)
    await act(async () => {})
    found = [{ kind: 'claude', command: 'claude', binary: '/opt/bin/claude' }]
    const again = screen.getByRole('button', { name: 'Check Again' })
    again.focus()
    await act(async () => {
      fireEvent.click(again)
    })
    expect(call).toHaveBeenCalledWith('agent.list', { versions: true, fresh: true })
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Open Folder/ }))
  })

  it('waits for the first look before saying anything', async () => {
    useWorkspaceStore.setState({ agentsProbed: false })
    call.mockImplementation(() => new Promise(() => {}))
    render(<Welcome modifier={MAC} project={undefined} />)
    expect(panel()).toBeNull()
  })
})
