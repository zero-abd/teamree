/** @vitest-environment jsdom */

// The frame all four full-page views share: one head, one close, one column, one Escape.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneConsent } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { PageFrame } = await import('./PageFrame')

const INITIAL = useWorkspaceStore.getState()
const onClose = vi.fn()

const ASKING: PaneConsent = {
  projectId: 'p1',
  requests: [
    {
      id: 'c1',
      projectId: 'p1',
      terminalId: 't1',
      handle: 'sam',
      publicKey: 'k',
      since: 1,
      at: 2,
      expiresAt: Number.MAX_SAFE_INTEGER,
      writes: 1,
      bytes: 1,
      preview: 'x',
      clipped: false
    }
  ],
  standing: [],
  readAt: 2
}

beforeEach(() => {
  onClose.mockReset()
  useWorkspaceStore.setState(INITIAL, true)
})

function frame(extra: Partial<React.ComponentProps<typeof PageFrame>> = {}): void {
  render(
    <PageFrame label="Things" title="Things" onClose={onClose} {...extra}>
      <p>body</p>
    </PageFrame>
  )
}

describe('the page frame', () => {
  it('is a landmark with the title, the page’s controls and a ×, over one column', () => {
    frame({ lede: '2 things', actions: <button type="button">Filter</button> })
    const main = screen.getByRole('main', { name: 'Things' })
    const head = main.querySelector('.page__head .page__column')
    expect(head?.querySelector('h1')?.textContent).toBe('Things')
    expect(head?.textContent).toContain('2 things')
    expect(head?.contains(screen.getByRole('button', { name: 'Filter' }))).toBe(true)
    expect(main.querySelector('.page__body .page__column')?.textContent).toBe('body')
  })

  it('closes on the × and on Escape', () => {
    frame()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the panes' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('leaves Escape to a dialog or a teammate’s question on top of it', () => {
    useWorkspaceStore.setState({ dialog: { kind: 'palette' } })
    frame()
    fireEvent.keyDown(window, { key: 'Escape' })
    useWorkspaceStore.setState({ dialog: null, consent: { p1: ASKING } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('takes the focus on open, unless the page lands it itself', () => {
    const { unmount } = render(
      <PageFrame label="Things" title="Things" onClose={onClose}>
        <p>body</p>
      </PageFrame>
    )
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Things' }))
    unmount()
    frame({ focusKey: false })
    expect(document.activeElement).toBe(document.body)
  })

  it('takes the focus again when its key changes', () => {
    const view = render(
      <PageFrame label="Things" title="Things" onClose={onClose} focusKey="a">
        <button type="button">inside</button>
      </PageFrame>
    )
    screen.getByRole('button', { name: 'inside' }).focus()
    view.rerender(
      <PageFrame label="Things" title="Things" onClose={onClose} focusKey="b">
        <button type="button">inside</button>
      </PageFrame>
    )
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Things' }))
  })
})
