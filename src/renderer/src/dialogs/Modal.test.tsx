/** @vitest-environment jsdom */

// Who owns the keyboard when a modal is up — and which one, when two are.
//
// Two can be on screen at once. Every dialog in this app is something the user
// opened, and until recently that meant one at a time: opening the next one
// replaced the last. A question about a teammate's keystrokes is not the
// user's action, arrives on somebody else's schedule, and renders above
// whatever they already had open — so "a modal" and "the modal" stopped being
// the same thing, and the difference is entirely about keys.
//
// Each instance listens on the window in the capture phase, so without a rule
// about which one answers, both do: the panel underneath pulls the focus out of
// the one on top, into a dialog the scrim is covering, and Escape aimed at the
// top one closes something the person cannot see.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

// The trap only cycles controls it can see, and "can see" is `offsetParent`.
// jsdom has no layout, so that is null on everything and every candidate would
// be thrown away — which would leave the assertions below passing because
// nothing happened at all. Stubbed here rather than in the shared DOM setup,
// which deliberately keeps measurements out of itself: this is the one file
// where the measurement has to mean something.
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

describe('one modal', () => {
  it('moves the focus into itself, and closes on Escape and on the backdrop', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Modal title="Appearance" onClose={onClose}>
        <button type="button">Reset</button>
      </Modal>
    )

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reset' }))
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  // The effect that arms all of this used to depend on the `onClose` it was
  // handed, and a dialog that re-renders on a clock hands it a new function
  // every tick. The consent prompt counts seconds, so its panel was re-armed
  // once a second and the focus was dragged back to the first button each time
  // — on the one dialog in the app where tabbing to the answer you mean is the
  // whole interaction.
  it('does not drag the focus back to the first control when the caller re-renders', async () => {
    const user = userEvent.setup()
    function Ticking(): React.JSX.Element {
      return (
        // A fresh function identity on every render, exactly as a dialog with a
        // countdown in it produces.
        <Modal title="Question" onClose={() => {}}>
          <button type="button">Refuse</button>
          <button type="button">Allow</button>
        </Modal>
      )
    }
    const { rerender } = render(<Ticking />)

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Allow' }))
    rerender(<Ticking />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Allow' }))
  })
})

describe('two modals', () => {
  function Stacked({ onUnder, onOver }: { onUnder: () => void; onOver: () => void }): React.JSX.Element {
    return (
      <>
        <Modal title="Appearance" onClose={onUnder}>
          <button type="button">Reset</button>
        </Modal>
        <Modal title="priya wants to type in t_7" onClose={onOver}>
          <button type="button">Refuse</button>
        </Modal>
      </>
    )
  }

  it('gives the keyboard to the one that opened last, and Escape with it', async () => {
    const user = userEvent.setup()
    const onUnder = vi.fn()
    const onOver = vi.fn()
    render(<Stacked onUnder={onUnder} onOver={onOver} />)

    await user.keyboard('{Escape}')
    expect(onOver).toHaveBeenCalledOnce()
    // The dialog underneath is covered by the one on top and by its scrim. A
    // key aimed at what is on screen must not close what is not.
    expect(onUnder).not.toHaveBeenCalled()
  })

  it('traps Tab inside the one on top, not in the one it is covering', async () => {
    const user = userEvent.setup()
    render(<Stacked onUnder={vi.fn()} onOver={vi.fn()} />)

    const refuse = screen.getByRole('button', { name: 'Refuse' })
    expect(document.activeElement).toBe(refuse)
    await user.tab()
    // One focusable in the top panel, so the trap brings it back to itself. The
    // failure this asserts against is the panel underneath claiming the focus
    // and the person reading the question tabbing through a dialog the scrim is
    // covering.
    expect(document.activeElement).toBe(refuse)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(refuse)
  })

  // And only the one that had it hands it back. A dialog that closes from
  // underneath — dismissed by something other than the person while the
  // question stands over it — must not drag the focus into a panel that is
  // about to stop existing.
  it('leaves the focus alone when the one underneath goes instead', () => {
    const { rerender } = render(<Stacked onUnder={vi.fn()} onOver={vi.fn()} />)
    const refuse = screen.getByRole('button', { name: 'Refuse' })
    expect(document.activeElement).toBe(refuse)

    rerender(
      <>
        <Modal title="priya wants to type in t_7" onClose={vi.fn()}>
          <button type="button">Refuse</button>
        </Modal>
      </>
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refuse' }))
  })

  it('hands the keyboard back when the one on top goes', async () => {
    const user = userEvent.setup()
    const onUnder = vi.fn()
    const { rerender } = render(<Stacked onUnder={onUnder} onOver={vi.fn()} />)

    rerender(
      <>
        <Modal title="Appearance" onClose={onUnder}>
          <button type="button">Reset</button>
        </Modal>
      </>
    )
    await user.keyboard('{Escape}')
    expect(onUnder).toHaveBeenCalledOnce()
  })
})
