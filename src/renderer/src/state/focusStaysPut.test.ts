/** @vitest-environment jsdom */

// Where the next keystroke goes is this window's to decide, and only the person
// at it may change the answer. The workspace stream reports what the runtime
// did — for this window, for another, for an agent on the CLI — and none of
// that is a request to be somewhere else. These are the two stream events that
// used to move the focus anyway: a worktree removed from elsewhere while it was
// in front, and a layout arriving with its focus on a pane somebody else made.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, PaneNode, Terminal, Worktree } from '@shared/entities'
import type { WorkspaceEvent } from '@shared/methods'

const answers = new Map<string, (params: unknown) => unknown>()
const call = vi.fn((method: string, params: unknown): Promise<unknown> => {
  const answer = answers.get(method)
  return answer ? Promise.resolve(answer(params)) : Promise.reject(new Error(`${method} is not answered here`))
})
let stream: ((event: WorkspaceEvent) => void) | null = null

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: (onEvent: (event: WorkspaceEvent) => void) => {
      stream = onEvent
      return { close: () => {} }
    },
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')

const INITIAL = useWorkspaceStore.getState()
const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

const worktree = (id: string): Worktree => ({
  id,
  projectId: 'p1',
  name: id,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
})

const terminal = (id: string, worktreeId: string): Terminal => ({
  id,
  worktreeId,
  title: 'zsh',
  cwd: `/wt/${worktreeId}`,
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0
})

const split = (...terminalIds: string[]): PaneNode => ({
  kind: 'split',
  direction: 'row',
  sizes: terminalIds.map(() => 1 / terminalIds.length),
  children: terminalIds.map((terminalId) => ({ kind: 'leaf', terminalId }))
})

const layout = (worktreeId: string, root: PaneNode, focusedTerminalId: string): Layout => ({
  worktreeId,
  root,
  focusedTerminalId
})

/** What the runtime will say next, per method. */
function runtimeSays(next: Record<string, (params: unknown) => unknown>): void {
  answers.clear()
  for (const [method, answer] of Object.entries(next)) answers.set(method, answer)
}

function typingInto(): { worktreeId: string | null; terminalId: string | null } {
  const state = store()
  const worktreeId = state.activeWorktreeId
  return { worktreeId, terminalId: worktreeId ? (state.layouts[worktreeId]?.focusedTerminalId ?? null) : null }
}

let stopWatching: () => void = () => {}

beforeEach(() => {
  call.mockClear()
  stopWatching()
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'p1', path: '/repos/p1', baseRef: 'origin/main' }],
      worktrees: [worktree('w1'), worktree('w2')],
      openWorktreeIds: ['w2', 'w1'],
      activeWorktreeId: 'w1',
      terminals: { t1: terminal('t1', 'w1'), t2: terminal('t2', 'w1'), t9: terminal('t9', 'w2') },
      layouts: { w1: layout('w1', split('t1', 't2'), 't1'), w2: layout('w2', split('t9'), 't9') }
    },
    true
  )
  runtimeSays({
    'terminal.list': () => Object.values(store().terminals),
    'layout.get': (params) => store().layouts[(params as { worktreeId: string }).worktreeId],
    'layout.set': (params) => (params as { layout: Layout }).layout,
    'worktree.list': () => store().worktrees
  })
  stopWatching = store().startWatching()
})

function push(event: WorkspaceEvent): void {
  if (!stream) throw new Error('the store is not watching the workspace')
  stream(event)
}

describe('a worktree removed from elsewhere while it is in front', () => {
  it('leaves you on no tab rather than in another worktree’s pane', async () => {
    runtimeSays({ 'worktree.list': () => [worktree('w2')] })

    push({ type: 'worktrees' })
    await vi.waitFor(() => expect(store().worktrees.map((one) => one.id)).toEqual(['w2']))

    expect(typingInto()).toEqual({ worktreeId: null, terminalId: null })
    expect(store().openWorktreeIds).toEqual(['w2'])
  })

  it('does not touch a tab that was not in front', async () => {
    runtimeSays({ 'worktree.list': () => [worktree('w1')] })

    push({ type: 'worktrees' })
    await vi.waitFor(() => expect(store().worktrees.map((one) => one.id)).toEqual(['w1']))

    expect(typingInto()).toEqual({ worktreeId: 'w1', terminalId: 't1' })
  })
})

describe('a layout arriving from the stream with its focus moved', () => {
  it('keeps the pane you were typing into when a pane you did not ask for appears', async () => {
    // An agent on the CLI, a hook, another window: a third pane, and the
    // runtime's layout says it has the focus.
    useWorkspaceStore.setState((state) => ({ terminals: { ...state.terminals, t3: terminal('t3', 'w1') } }))
    runtimeSays({
      'terminal.list': () => Object.values(store().terminals),
      'layout.get': () => layout('w1', split('t1', 't2', 't3'), 't3')
    })

    push({ type: 'layout', worktreeId: 'w1' })
    await vi.waitFor(() => expect(store().layouts.w1?.root).toEqual(split('t1', 't2', 't3')))

    expect(typingInto()).toEqual({ worktreeId: 'w1', terminalId: 't1' })
  })

  it('follows the runtime when the pane you were in is gone', async () => {
    runtimeSays({ 'layout.get': () => layout('w1', split('t2'), 't2') })

    push({ type: 'layout', worktreeId: 'w1' })
    await vi.waitFor(() => expect(store().layouts.w1?.root).toEqual(split('t2')))

    expect(typingInto()).toEqual({ worktreeId: 'w1', terminalId: 't2' })
  })

  it('takes the runtime’s word for a tab that is not in front', async () => {
    runtimeSays({ 'layout.get': () => layout('w2', split('t9', 't10'), 't10') })

    push({ type: 'layout', worktreeId: 'w2' })
    await vi.waitFor(() => expect(store().layouts.w2?.root).toEqual(split('t9', 't10')))

    expect(store().layouts.w2?.focusedTerminalId).toBe('t10')
    expect(typingInto()).toEqual({ worktreeId: 'w1', terminalId: 't1' })
  })

  it('still focuses the pane you asked this window for', async () => {
    runtimeSays({
      'terminal.create': () => terminal('t3', 'w1'),
      'terminal.list': () => [...Object.values(store().terminals), terminal('t3', 'w1')],
      'layout.get': () => layout('w1', split('t1', 't2', 't3'), 't3'),
      'layout.set': (params) => (params as { layout: Layout }).layout
    })

    await store().createTerminal('w1')

    expect(typingInto()).toEqual({ worktreeId: 'w1', terminalId: 't3' })
  })

  it('focuses the pane you started from the agent picker, and not the one the runtime opens after it', async () => {
    // The picker is a click, the same as the new-terminal button, and its pane
    // goes in front. The pane that arrives next on the stream — an agent on
    // the CLI, a hook — is nobody's click here, and it does not.
    runtimeSays({
      'terminal.create': (params) => {
        expect(params).toMatchObject({ worktreeId: 'w1', command: 'claude' })
        return terminal('t3', 'w1')
      },
      'terminal.list': () => [...Object.values(store().terminals), terminal('t3', 'w1')],
      'layout.get': () => layout('w1', split('t1', 't2', 't3'), 't3'),
      'layout.set': (params) => (params as { layout: Layout }).layout
    })

    await store().startAgent('claude')

    expect(typingInto()).toEqual({ worktreeId: 'w1', terminalId: 't3' })

    useWorkspaceStore.setState((state) => ({ terminals: { ...state.terminals, t4: terminal('t4', 'w1') } }))
    runtimeSays({
      'terminal.list': () => Object.values(store().terminals),
      'layout.get': () => layout('w1', split('t1', 't2', 't3', 't4'), 't4')
    })

    push({ type: 'layout', worktreeId: 'w1' })
    await vi.waitFor(() => expect(store().layouts.w1?.root).toEqual(split('t1', 't2', 't3', 't4')))

    expect(typingInto()).toEqual({ worktreeId: 'w1', terminalId: 't3' })
  })
})
