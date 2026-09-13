/** @vitest-environment jsdom */

// The owner's end of the prompt.
//
// Two things are asserted here and neither is cosmetic. The first is that the
// dialog puts the three facts a decision needs in front of the person making it
// — who, which pane, and what — and puts the *bytes* there as text rather than
// as something a terminal would act on. The second is that the answer it sends
// carries the count the owner was actually shown, because that is what stops an
// "allow once" taken on four keystrokes admitting the fourteen that arrived
// while it was being read.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ConsentRequest } from '@shared/entities'

const decideConsent = vi.fn<(requestId: string, decision: string, through: number) => Promise<void>>()

vi.mock('../state/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: unknown) => unknown) => select({ decideConsent })
}))

const { firstQuestion, RemoteKeystrokesDialog } = await import('./RemoteKeystrokesDialog')

function request(overrides: Partial<ConsentRequest> = {}): ConsentRequest {
  return {
    id: 'ask_1',
    projectId: 'p1',
    terminalId: 't_7',
    handle: 'priya',
    publicKey: 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM=',
    since: 1_000,
    at: 1_500,
    expiresAt: Date.now() + 60_000,
    writes: 4,
    bytes: 4,
    preview: 'npm test⏎',
    clipped: false,
    ...overrides
  }
}

describe('the question the owner is asked', () => {
  it('names who, which pane, and what, in one place', () => {
    render(<RemoteKeystrokesDialog request={request()} />)
    expect(screen.getByRole('dialog', { name: 'priya wants to type in t_7' })).toBeTruthy()
    expect(screen.getByText('npm test⏎')).toBeTruthy()
    // And says what it will cost, in the only terms that matter: this runs on
    // your machine, as you.
    expect(screen.getByText(/runs on your machine, as you/)).toBeTruthy()
  })

  it('shows the bytes as text, never as something the pane would obey', () => {
    // Already rendered by the runtime — see `writePreview.ts` — and what this
    // asserts is that the dialog puts that string on screen unchanged rather
    // than interpreting any of it on the way.
    const preview = '^[[2Jsudo \\u202erm -rf /⏎'
    render(<RemoteKeystrokesDialog request={request({ preview })} />)
    const shown = screen.getByText(preview)
    expect(shown.textContent).toBe(preview)
    // No markup came in with it: React escapes, and this is the assertion that
    // says so out loud.
    expect(shown.innerHTML).not.toContain('<')
  })

  it('answers with the number of keystrokes the owner was shown', async () => {
    const user = userEvent.setup()
    render(<RemoteKeystrokesDialog request={request({ writes: 4 })} />)
    await user.click(screen.getByRole('button', { name: 'Allow this once' }))
    expect(decideConsent).toHaveBeenCalledWith('ask_1', 'once', 4)
  })

  it('offers all four answers, and a refusal among them', async () => {
    const user = userEvent.setup()
    decideConsent.mockClear()
    render(<RemoteKeystrokesDialog request={request()} />)
    await user.click(screen.getByRole('button', { name: 'Refuse' }))
    await user.click(screen.getByRole('button', { name: 'Allow until this session ends' }))
    await user.click(screen.getByRole('button', { name: 'Always allow priya here' }))
    expect(decideConsent.mock.calls.map((call) => call[1])).toEqual(['deny', 'session', 'always'])
  })

  it('cannot be dismissed by pressing Escape', async () => {
    const user = userEvent.setup()
    decideConsent.mockClear()
    render(<RemoteKeystrokesDialog request={request()} />)
    await user.keyboard('{Escape}')
    // Still there, and still unanswered. A stray key must not be able to
    // decide somebody else's keystrokes either way.
    expect(screen.getByRole('dialog', { name: 'priya wants to type in t_7' })).toBeTruthy()
    expect(decideConsent).not.toHaveBeenCalled()
  })

  it('says when it is holding more than it is showing', () => {
    render(<RemoteKeystrokesDialog request={request({ clipped: true })} />)
    expect(screen.getByText(/More is being held than fits here/)).toBeTruthy()
  })
})

describe('which question goes on screen', () => {
  it('puts up the oldest, one at a time', () => {
    const first = request({ id: 'ask_1', since: 100 })
    const second = request({ id: 'ask_2', since: 200 })
    expect(firstQuestion({ p1: { requests: [second, first] } })?.id).toBe('ask_1')
  })

  it('puts up nothing when nobody is waiting', () => {
    expect(firstQuestion({ p1: { requests: [] } })).toBeNull()
  })
})
