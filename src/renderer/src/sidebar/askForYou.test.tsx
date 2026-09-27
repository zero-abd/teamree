/** @vitest-environment jsdom */

// Messages on a worktree row: a question for you turns the row amber and answers from it;
// a child's done shows on its parent, and a task's own report on its row.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'
import type { TaskMessage } from '@shared/messages'

const call = vi.fn((_method: string, _params: unknown): Promise<unknown> => Promise.resolve([]))

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
const { useMessageStore, askForYou, askingWorktrees, childDone, firstSentence } = await import('../state/messages')
const { WorktreeRow } = await import('./WorktreeRow')

const worktree = (id: string, name: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1,
  ...extra
})

const LEAD = worktree('lead', 'Rate limits')
const TESTS = worktree('tests', 'Write tests', { parentId: 'lead' })

const message = (extra: Partial<TaskMessage>): TaskMessage => ({
  id: 7,
  projectId: 'p1',
  kind: 'ask',
  from: { worktreeId: 'tests', terminalId: 'term_2' },
  to: { you: true },
  text: 'Which store for the limiter?',
  options: ['redis', 'postgres'],
  at: 1,
  state: 'queued',
  ...extra
})

function mount(row: Worktree, compact = false): void {
  render(
    <ul>
      <WorktreeRow
        worktree={row}
        compact={compact}
        status={undefined}
        mergePreview={undefined}
        terminals={[]}
        evidence={{}}
        watchers={{}}
        unread={new Set()}
        now={1}
        active={false}
        openIn={[]}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
        onForget={vi.fn()}
        onFocusTerminal={vi.fn()}
        onReveal={vi.fn()}
        onCopyPath={vi.fn()}
        onCopyBranch={vi.fn()}
        onRename={vi.fn()}
      />
    </ul>
  )
}

beforeEach(() => {
  call.mockClear()
  useWorkspaceStore.setState({ worktrees: [LEAD, TESTS] })
})
afterEach(() => {
  cleanup()
  useMessageStore.setState({ messages: [] })
})

describe('a question for you', () => {
  it('turns the row amber and offers its answers', () => {
    useMessageStore.setState({ messages: [message({})] })
    mount(TESTS)
    expect(screen.getByRole('img', { name: 'asking', hidden: true })).toBeTruthy()
    expect(screen.getByText('Which store for the limiter?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'postgres' }))
    expect(call).toHaveBeenCalledWith('message.send', {
      from: { you: true },
      to: { worktreeId: 'tests', terminalId: 'term_2' },
      kind: 'reply',
      replyTo: 7,
      text: 'postgres'
    })
  })

  it('takes any answer through Reply…', async () => {
    useMessageStore.setState({ messages: [message({ options: undefined })] })
    mount(TESTS)
    fireEvent.click(screen.getByRole('button', { name: 'Reply…' }))
    const field = screen.getByRole('textbox', { name: 'Answer' })
    fireEvent.change(field, { target: { value: 'Use postgres advisory locks' } })
    fireEvent.submit(field)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'message.send',
        expect.objectContaining({ text: 'Use postgres advisory locks' })
      )
    )
  })

  it('goes once answered', () => {
    useMessageStore.setState({ messages: [message({ state: 'answered', answeredBy: { worktreeId: 'lead' } })] })
    mount(TESTS)
    expect(screen.queryByRole('group', { name: 'Question #7' })).toBeNull()
  })
})

describe('a question the agent stopped waiting on', () => {
  const lapsed = (extra: Partial<TaskMessage> = {}): TaskMessage => message({ expiredAt: 5, ...extra })

  it('says so, stops asking, and sends an answer anyway as a note', async () => {
    useMessageStore.setState({ messages: [lapsed()] })
    mount(TESTS)
    expect(screen.getByText('Timed out · the agent moved on')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'asking', hidden: true })).toBeNull()
    expect(screen.queryByRole('button', { name: 'postgres' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send Anyway…' }))
    fireEvent.click(screen.getByRole('button', { name: 'postgres' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('message.send', {
        from: { you: true },
        to: { worktreeId: 'tests', terminalId: 'term_2' },
        kind: 'note',
        replyTo: 7,
        text: 'postgres'
      })
    )
  })

  it('is dismissed, and then gone', async () => {
    useMessageStore.setState({ messages: [lapsed()] })
    mount(TESTS)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('message.read', { ids: [7] }))
    cleanup()
    useMessageStore.setState({ messages: [lapsed({ state: 'read' })] })
    mount(TESTS)
    expect(screen.queryByRole('group', { name: 'Question #7' })).toBeNull()
  })
})

describe('a question for you, compact', () => {
  it('keeps one line: the question, then its answers', () => {
    useMessageStore.setState({ messages: [message({})] })
    mount(TESTS, true)
    const card = screen.getByRole('group', { name: 'Question #7' })
    expect(card.className).toContain('worktree__ask--compact')
    expect(screen.getByText('Which store for the limiter?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'redis' })).toBeTruthy()
  })

  it('leaves out one nobody waits on', () => {
    useMessageStore.setState({ messages: [message({ expiredAt: 5 })] })
    mount(TESTS, true)
    expect(screen.queryByRole('group', { name: 'Question #7' })).toBeNull()
  })
})

describe('done', () => {
  it("shows a child's done on its parent, and a task's report on its own row", () => {
    useMessageStore.setState({
      messages: [
        message({
          id: 9,
          kind: 'done',
          to: { worktreeId: 'lead' },
          outcome: 'succeeded',
          text: 'Added limiter tests. All pass.'
        })
      ]
    })
    mount(LEAD)
    expect(screen.getByText('✓ Write tests: Added limiter tests.')).toBeTruthy()
    cleanup()
    mount({ ...TESTS, report: { outcome: 'failed', summary: 'Could not reproduce. Gave up.', paths: [], at: 1 } })
    expect(screen.getByText('✗ Could not reproduce.')).toBeTruthy()
  })
})

describe('the selectors', () => {
  it('pick the newest open ask for you, and the newest done to a parent', () => {
    const older = message({ id: 1 })
    const newer = message({ id: 2 })
    const elsewhere = message({ id: 3, to: { worktreeId: 'lead' } })
    expect(askForYou([older, newer, elsewhere], 'tests')).toBe(newer)
    expect(askForYou([older], 'lead')).toBeUndefined()
    expect(askForYou([message({ expiredAt: 5, state: 'read' })], 'tests')).toBeUndefined()
    const live = message({ id: 5, from: { worktreeId: 'lead' } })
    expect([...askingWorktrees([older, message({ id: 6, expiredAt: 5 }), live, elsewhere])]).toEqual(['tests', 'lead'])
    const done = message({ id: 4, kind: 'done', to: { worktreeId: 'lead' } })
    expect(childDone([older, done], 'lead')).toBe(done)
    expect(firstSentence('Added it. Tests pass.\nMore.')).toBe('Added it.')
    expect(firstSentence('v1.2 shipped')).toBe('v1.2 shipped')
  })
})
