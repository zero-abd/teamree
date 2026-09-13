// Closing a pane, with the window's store on one side and the real terminal
// runtime on the other.
//
// The store's own tests answer it from an in-memory double, and a double agrees
// with whatever the store does to it. This defect only exists where the two
// disagree: the runtime removes the closed leaf and saves the worktree's layout
// itself, so anything the renderer recomputes from its own copy and writes back
// is a second, older answer to a question already answered — and a pane opened
// from somewhere else a moment earlier is not in that older answer. It takes
// the real session manager to show that, so this drives one.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Layout, Terminal } from '../src/shared/entities'
import { createTerminalService, type TerminalService } from '../src/main/terminals/method-handlers'
import { canSpawnPty } from '../src/main/terminals/pty-test-support'

const WORKTREE = 'wt_close'

/** Set once the real service exists; the mock below reaches it through this. */
const runtime = vi.hoisted(() => ({
  answer: undefined as undefined | ((method: string, params: unknown) => Promise<unknown>)
}))

vi.mock('../src/renderer/src/runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => runtime.answer!(method, params),
    // Nothing subscribes here, which is the situation being reproduced: the
    // window acting on the copy it holds, before the next announcement about
    // that worktree has reached it.
    watchWorkspace: () => ({ close: () => {} }),
    subscribeTerminal: () => Promise.reject(new Error('the pane close harness does not stream')),
    watchPane: () => Promise.reject(new Error('the pane close harness does not stream')),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

import { collectTerminalIds } from '../src/renderer/src/panes/paneLayout'
import { useWorkspaceStore } from '../src/renderer/src/state/workspaceStore'

let service: TerminalService
let checkout: string

const openPane = (): Promise<Terminal> => service.handlers['terminal.create']({ worktreeId: WORKTREE })
const savedLayout = (): Promise<Layout> => service.handlers['layout.get']({ worktreeId: WORKTREE })

beforeAll(async () => {
  checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-pane-close-'))
  service = createTerminalService({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? checkout : undefined)
  })
  runtime.answer = async (method, params) => {
    const handlers = service.handlers as unknown as Record<string, ((params: unknown) => Promise<unknown>) | undefined>
    const handler = handlers[method]
    if (!handler) throw new Error(`this harness answers terminals and layouts only, not ${method}`)
    return handler(params)
  }
})

afterAll(async () => {
  await service?.shutdown()
  await rm(checkout, { recursive: true, force: true })
})

const describePty = canSpawnPty() ? describe : describe.skip

describePty('closing a pane', () => {
  it('leaves a pane opened elsewhere where it can still be reached', async () => {
    const kept = await openPane()
    const closing = await openPane()

    // What the window is holding: the two panes it knows about.
    useWorkspaceStore.setState({
      openWorktreeIds: [WORKTREE],
      activeWorktreeId: WORKTREE,
      layouts: { [WORKTREE]: await savedLayout() },
      terminals: { [kept.id]: kept, [closing.id]: closing }
    })

    // An agent runs `teamree terminal create` in the worktree on screen. The
    // runtime has the new pane; this window has not been told yet.
    const elsewhere = await openPane()

    await useWorkspaceStore.getState().closeTerminal(closing.id)

    const saved = await savedLayout()
    expect(collectTerminalIds(saved.root)).toContain(elsewhere.id)
    expect(collectTerminalIds(saved.root)).toContain(kept.id)
    expect(collectTerminalIds(saved.root)).not.toContain(closing.id)

    // And the window agrees the moment it re-reads. A pane with no leaf in the
    // saved tree is unreachable for good: reveal focuses through the layout,
    // and a focus id that is not in the tree is refused.
    await useWorkspaceStore.getState().openWorktree(WORKTREE)
    const shown = useWorkspaceStore.getState().layouts[WORKTREE]
    expect(collectTerminalIds(shown?.root ?? null)).toContain(elsewhere.id)
  })
})
