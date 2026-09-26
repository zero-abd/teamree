/** @vitest-environment jsdom */

// The incident, end to end: somebody is typing into a pane of their own when an
// agent in another worktree stops. Both halves of the notification are the real
// ones — the main process's channel and this window's hook, joined by a fake of
// the two IPC channels the preload carries — and the store is the real store.
//
// What has to be true is that the notice arriving changes nothing about where
// the next keystroke goes. The one thing that may change it is the click on the
// notification, which is the person asking to be taken there.

import { render } from '@testing-library/react'
import type { IpcMain, IpcMainEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Layout, Worktree } from '@shared/entities'
import {
  installAgentNotices,
  NOTICE_PUBLISH_CHANNEL,
  NOTICE_REVEAL_CHANNEL,
  type AgentNotice,
  type AgentNoticeChannel
} from '../../../main/agentNotices'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: { worktreeId?: string }) => {
      const state = useWorkspaceStore.getState()
      switch (method) {
        case 'terminal.list':
          return Promise.resolve([])
        case 'layout.get':
          return Promise.resolve(state.layouts[params.worktreeId ?? ''])
        case 'layout.set':
          return Promise.resolve((params as { layout: Layout }).layout)
        default:
          return Promise.reject(new Error(`${method} is not answered here`))
      }
    },
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

import { vi } from 'vitest'
const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useAgentNotices } = await import('./useAgentNotices')

const INITIAL = useWorkspaceStore.getState()

const worktree = (id: string, name: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: name.toLowerCase().replace(/ /g, '-'),
  path: `/wt/${id}`,
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
})

const layout = (worktreeId: string, terminalId: string): Layout => ({
  worktreeId,
  root: { kind: 'leaf', terminalId },
  focusedTerminalId: terminalId
})

type Shown = { title: string; body: string; silent: boolean; onActivate: () => void }

/**
 * The preload's two channels, as a pair of function calls: the window's
 * settings go up, and a reveal comes down to whoever is listening.
 */
function wire(windowFocused: boolean): { main: AgentNoticeChannel; shown: Shown[] } {
  const listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>()
  const ipc = {
    on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) =>
      listeners.set(channel, listener),
    removeAllListeners: (channel: string) => listeners.delete(channel),
    handle: () => {},
    removeHandler: () => {}
  } as unknown as IpcMain
  const reveals = new Set<(pane: { worktreeId: string; terminalId: string }) => void>()
  const sender = {
    isDestroyed: () => false,
    mainFrame: {},
    send: (channel: string, pane: { worktreeId: string; terminalId: string }) => {
      if (channel !== NOTICE_REVEAL_CHANNEL) throw new Error(`unexpected channel ${channel}`)
      for (const listener of [...reveals]) listener(pane)
    }
  }
  const shown: Shown[] = []
  const main = installAgentNotices(ipc, {
    windowFocused: () => windowFocused,
    show: (spec) => shown.push(spec),
    setBadge: () => {},
    focusWindow: () => {},
    fromMainFrame: () => true,
    blocked: () => false,
    openSettings: () => {}
  })
  ;(window as unknown as { teamree: unknown }).teamree = {
    notices: {
      publish: (settings: unknown) =>
        listeners.get(NOTICE_PUBLISH_CHANNEL)?.(
          { sender, senderFrame: sender.mainFrame } as unknown as IpcMainEvent,
          settings
        ),
      onReveal: (listener: (pane: { worktreeId: string; terminalId: string }) => void) => {
        reveals.add(listener)
        return () => reveals.delete(listener)
      }
    }
  }
  return { main, shown }
}

function Harness(): null {
  useAgentNotices()
  return null
}

/** Where the next keystroke goes: the tab in front and the pane in it. */
function typingInto(): { worktreeId: string | null; terminalId: string | null } {
  const state = useWorkspaceStore.getState()
  const worktreeId = state.activeWorktreeId
  return { worktreeId, terminalId: worktreeId ? (state.layouts[worktreeId]?.focusedTerminalId ?? null) : null }
}

const theirs: AgentNotice = {
  terminalId: 't_theirs',
  worktreeId: 'w_theirs',
  worktree: 'Plan the spend summary',
  reason: 'quiet',
  line: 'Login successful. Press Enter to continue'
}

beforeEach(() => {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree('w_mine', 'fg repo task'), worktree('w_theirs', 'Plan the spend summary')],
      openWorktreeIds: ['w_theirs', 'w_mine'],
      activeWorktreeId: 'w_mine',
      layouts: { w_mine: layout('w_mine', 't_mine'), w_theirs: layout('w_theirs', 't_theirs') }
    },
    true
  )
})

afterEach(() => {
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('an agent stopping in another worktree while you type into yours', () => {
  it('moves neither the tab nor the pane, however it is shown', async () => {
    for (const windowFocused of [true, false]) {
      const { main, shown } = wire(windowFocused)
      const view = render(<Harness />)

      main.deliver(theirs)
      await Promise.resolve()

      expect(shown).toHaveLength(1)
      expect(typingInto()).toEqual({ worktreeId: 'w_mine', terminalId: 't_mine' })
      view.unmount()
    }
  })

  it('takes you there from the click on the notification, which is you asking', async () => {
    const { main, shown } = wire(false)
    render(<Harness />)
    main.deliver(theirs)

    shown[0]?.onActivate()
    await vi.waitFor(() => expect(typingInto()).toEqual({ worktreeId: 'w_theirs', terminalId: 't_theirs' }))
  })

  it('ignores a reveal for a worktree this window does not have', async () => {
    const { main, shown } = wire(false)
    render(<Harness />)
    main.deliver({ ...theirs, worktreeId: 'w_elsewhere', terminalId: 't_elsewhere' })

    shown[0]?.onActivate()
    await Promise.resolve()

    expect(typingInto()).toEqual({ worktreeId: 'w_mine', terminalId: 't_mine' })
  })
})
