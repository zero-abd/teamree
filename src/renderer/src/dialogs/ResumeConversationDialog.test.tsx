/** @vitest-environment jsdom */

// Resume Conversation: a worktree's past conversations, newest first; the one chosen starts in a new pane.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConversation } from '@shared/entities'

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
const { ResumeConversationDialog } = await import('./ResumeConversationDialog')

const INITIAL = useWorkspaceStore.getState()
const NOW = Date.now()

const CONVERSATIONS: AgentConversation[] = [
  { agent: 'claude', sessionId: 'c-2', title: 'auth work', prompt: 'fix login', updatedAt: NOW - 60_000, messages: 12 },
  { agent: 'codex', sessionId: 'x-1', prompt: 'rename the config flag', updatedAt: NOW - 3_600_000, messages: 4 },
  { agent: 'claude', sessionId: 'c-1', prompt: 'write the release notes', updatedAt: NOW - 86_400_000, messages: 2 }
]

const created = (): unknown[] => call.mock.calls.filter(([method]) => method === 'terminal.create').map(([, p]) => p)

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method, params) => {
    if (method === 'agent.conversations') return CONVERSATIONS
    if (method === 'terminal.create') {
      return { id: 'term_9', worktreeId: (params as { worktreeId: string }).worktreeId }
    }
    return []
  })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'wt_1',
      agents: [
        { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
        { kind: 'codex', command: 'codex', binary: '/usr/local/bin/codex' }
      ],
      agentArgs: { claude: '--model opus' },
      dialog: { kind: 'resume-conversation', worktreeId: 'wt_1' }
    },
    true
  )
})

describe('Resume Conversation', () => {
  it('lists the worktree’s conversations with their title, age and message count', async () => {
    render(<ResumeConversationDialog worktreeId="wt_1" />)
    const list = await screen.findByRole('listbox', { name: 'Conversations' })
    const rows = within(list).getAllByRole('option')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('auth work'),
      expect.stringContaining('rename the config flag'),
      expect.stringContaining('write the release notes')
    ])
    expect(rows[0]?.textContent).toContain('12 messages')
    expect(call).toHaveBeenCalledWith('agent.conversations', { worktreeId: 'wt_1' })
  })

  it('narrows by what was typed, the first prompt included', async () => {
    render(<ResumeConversationDialog worktreeId="wt_1" />)
    await screen.findByText('auth work')
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'login' } })
    expect(screen.getAllByRole('option').map((row) => row.textContent)).toEqual([expect.stringContaining('auth work')])
  })

  it('starts the chosen agent on that conversation, with the arguments the owner always passes', async () => {
    render(<ResumeConversationDialog worktreeId="wt_1" />)
    await screen.findByText('rename the config flag')
    fireEvent.keyDown(screen.getByLabelText('Filter'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await vi.waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toMatchObject({ worktreeId: 'wt_1', command: 'codex', resume: 'x-1' })
    expect(useWorkspaceStore.getState().dialog).toBeNull()
  })

  it('passes the owner’s arguments for Claude Code, and resumes on a double-click', async () => {
    render(<ResumeConversationDialog worktreeId="wt_1" />)
    fireEvent.doubleClick(await screen.findByText('auth work'))
    await vi.waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toMatchObject({ command: 'claude', resume: 'c-2', agentArgs: '--model opus' })
  })

  it('says so when there is nothing to resume', async () => {
    call.mockImplementation(async () => [])
    render(<ResumeConversationDialog worktreeId="wt_1" />)
    expect(await screen.findByText('No past conversations')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('cannot resume a conversation whose agent is not installed', async () => {
    useWorkspaceStore.setState({ agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }] })
    render(<ResumeConversationDialog worktreeId="wt_1" />)
    const codex = (await screen.findByText('rename the config flag')).closest('button') as HTMLButtonElement
    expect(codex.disabled).toBe(true)
  })
})
