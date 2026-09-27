/** @vitest-environment jsdom */

// The corner stack as drawn: each notice a card with its icon, title, detail and actions, and a dismissed one
// that slides out before it goes.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { NoticeStack } = await import('./NoticeStack')
const { noticeLook, noticeParts } = await import('./noticeView')

const INITIAL = useWorkspaceStore.getState()

beforeEach(() => {
  useWorkspaceStore.setState({ ...INITIAL, notices: [] }, true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const card = (title: string): HTMLElement => {
  const found = screen.getByText(title).closest<HTMLElement>('.notice')
  if (!found) throw new Error(`no notice ${title}`)
  return found
}

describe('a notice’s card', () => {
  it('heads an error with what failed and puts why under it, with the red edge and its icon', () => {
    useWorkspaceStore.setState({
      notices: [{ id: 1, text: 'Could not push: remote rejected main', tone: 'error' }]
    })
    render(<NoticeStack />)
    const notice = card('Could not push')
    expect(notice.className).toContain('notice--error')
    expect(within(notice).getByText('remote rejected main').className).toBe('notice__detail')
    expect(notice.querySelector('.notice__icon svg[data-icon="alert"]')).toBeTruthy()
  })

  it('draws news that can be undone as done, with Undo as a small button', () => {
    const undo = vi.fn(async () => {})
    const dismissNotice = vi.fn()
    useWorkspaceStore.setState({
      undo,
      dismissNotice,
      notices: [
        {
          id: 3,
          text: 'Deleted "cart totals"',
          tone: 'info',
          action: { label: 'Undo', undo: { kind: 'remove', projectId: 'p1', removedId: 'r1' } }
        }
      ]
    })
    render(<NoticeStack />)
    const notice = card('Deleted "cart totals"')
    expect(notice.className).toContain('notice--success')
    const button = within(notice).getByRole('button', { name: 'Undo' })
    expect(button.className).toContain('button--small')
    fireEvent.click(button)
    expect(dismissNotice).toHaveBeenCalledWith(3)
    expect(undo).toHaveBeenCalledWith({ kind: 'remove', projectId: 'p1', removedId: 'r1' })
  })

  it('keeps the live region mounted and saying what the stack shows', () => {
    render(<NoticeStack />)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    act(() => useWorkspaceStore.setState({ notices: [{ id: 1, text: 'Copied the path', tone: 'info' }] }))
    expect(within(screen.getByRole('status')).getByText('Copied the path')).toBeTruthy()
  })
})

describe('a dismissed notice', () => {
  it('slides out, out of reach of the pointer and the reader, then goes', () => {
    vi.useFakeTimers()
    useWorkspaceStore.setState({
      notices: [
        { id: 1, text: 'Copied the path', tone: 'info' },
        { id: 2, text: 'Added shop', tone: 'info' }
      ]
    })
    render(<NoticeStack />)
    act(() => useWorkspaceStore.getState().dismissNotice(1))
    const leaving = card('Copied the path')
    expect(leaving.className).toContain('notice--leaving')
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(leaving.hasAttribute('inert')).toBe(true)
    // Newest at the bottom, the leaving one in the place it had.
    expect([...document.querySelectorAll('.notice__title')].map((node) => node.textContent)).toEqual([
      'Copied the path',
      'Added shop'
    ])
    act(() => vi.advanceTimersByTime(400))
    expect(screen.queryByText('Copied the path')).toBeNull()
    expect(screen.getByText('Added shop')).toBeTruthy()
  })

  it('goes as soon as its slide ends', () => {
    useWorkspaceStore.setState({ notices: [{ id: 1, text: 'Copied the path', tone: 'info' }] })
    render(<NoticeStack />)
    act(() => useWorkspaceStore.getState().dismissNotice(1))
    fireEvent.animationEnd(card('Copied the path'))
    expect(screen.queryByText('Copied the path')).toBeNull()
  })
})

describe('the words on a card', () => {
  it('splits a short head from the reason after the first colon', () => {
    expect(noticeParts('git push was rejected: fetch first')).toEqual({
      title: 'git push was rejected',
      detail: 'fetch first'
    })
    expect(noticeParts('Committed 1a2b3c4: Round totals: fix')).toEqual({
      title: 'Committed 1a2b3c4',
      detail: 'Round totals: fix'
    })
  })

  it('keeps one title when there is no colon, nothing after it, or the head is a sentence', () => {
    expect(noticeParts('Copied the path to cart totals')).toEqual({ title: 'Copied the path to cart totals', detail: null })
    expect(noticeParts('Nothing to say: ')).toEqual({ title: 'Nothing to say: ', detail: null })
    const long = `${'x'.repeat(70)}: why`
    expect(noticeParts(long)).toEqual({ title: long, detail: null })
  })

  it('colours an error red, undoable news green, the rest neutral', () => {
    expect(noticeLook({ tone: 'error' })).toBe('error')
    expect(noticeLook({ tone: 'info', action: { label: 'Undo', undo: { kind: 'shared-note', shareId: 's' } } })).toBe(
      'success'
    )
    expect(noticeLook({ tone: 'info', action: { label: 'Open Review', url: 'https://x' } })).toBe('neutral')
    expect(noticeLook({ tone: 'info' })).toBe('neutral')
  })
})
