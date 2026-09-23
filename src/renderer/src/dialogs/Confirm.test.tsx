/** @vitest-environment jsdom */

// The one shape every yes-or-no question in the app takes, and what its keys
// do.
//
// A confirm is a question with two answers, and the keyboard has to reach both
// without a hand leaving it: Escape is always the answer that changes nothing,
// Enter is the answer that is safe to give by reflex — which is the cancel when
// the other button destroys something, and the confirm when it does not — and
// Tab moves between the two and nowhere else. The focus goes back to whatever
// opened the question when it closes, so pressing Escape leaves the person
// exactly where they were.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Confirm } from './Confirm'

// The trap only cycles controls it can see, and jsdom has no layout; see
// Modal.test.tsx for the whole of why this is stubbed here.
const measured = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    }
  })
})

afterAll(() => {
  if (measured) Object.defineProperty(HTMLElement.prototype, 'offsetParent', measured)
})

function Question({
  tone,
  onCancel,
  onConfirm
}: {
  tone: 'danger' | 'primary'
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Confirm
      title="Stop this agent?"
      body="claude is working in “claude”"
      cancel="Leave it open"
      confirm="Stop it and close"
      tone={tone}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

describe('what it draws', () => {
  it('is a dialog named by its question, one body line, and the two answers in order', () => {
    render(<Question tone="danger" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Stop this agent?' })
    expect(dialog.querySelector('.modal__body .confirm__body')?.textContent).toBe('claude is working in “claude”')
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('.modal__actions .button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Leave it open', 'Stop it and close'])
    // The destructive answer is the red one, and it is the one on the right.
    expect(buttons[1]?.classList.contains('button--danger')).toBe(true)
    expect(buttons[0]?.classList.contains('button--danger')).toBe(false)
  })

  it('draws a question that destroys nothing with a primary confirm instead', () => {
    render(<Question tone="primary" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const confirm = screen.getByRole('button', { name: 'Stop it and close' })
    expect(confirm.classList.contains('button--primary')).toBe(true)
    expect(confirm.classList.contains('button--danger')).toBe(false)
  })
})

describe('what the keys do', () => {
  it('cancels on Escape', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<Question tone="danger" onCancel={onCancel} onConfirm={onConfirm} />)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('gives Enter to the cancel when the other answer destroys something', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<Question tone="danger" onCancel={onCancel} onConfirm={onConfirm} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Leave it open' }))
    await user.keyboard('{Enter}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('gives Enter to the confirm when it destroys nothing', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<Question tone="primary" onCancel={onCancel} onConfirm={onConfirm} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop it and close' }))
    await user.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('keeps Tab between the two answers', async () => {
    const user = userEvent.setup()
    render(<Question tone="danger" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const cancel = screen.getByRole('button', { name: 'Leave it open' })
    const confirm = screen.getByRole('button', { name: 'Stop it and close' })
    await user.tab()
    expect(document.activeElement).toBe(confirm)
    await user.tab()
    expect(document.activeElement).toBe(cancel)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(confirm)
  })

  it('hands the focus back to whatever opened it', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(<Question tone="danger" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(document.activeElement).not.toBe(opener)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
