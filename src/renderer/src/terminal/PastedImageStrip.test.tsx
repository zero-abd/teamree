/** @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PastedImageStrip } from './PastedImageStrip'
import type { ShownImage } from './paneImageLinks'

afterEach(cleanup)

const one: ShownImage = { index: 1, url: 'teamree-file://s/1', path: '/t/s/images/1.png' }
const two: ShownImage = { index: 2, url: 'teamree-file://s/2', path: '/t/s/images/2.png' }

function strip(terminalId: string, images: ShownImage[], onOpen = vi.fn()) {
  const view = render(<PastedImageStrip terminalId={terminalId} images={images} onOpen={onOpen} />)
  return {
    ...view,
    onOpen,
    rerenderWith: (next: ShownImage[]) =>
      view.rerender(<PastedImageStrip terminalId={terminalId} images={next} onOpen={onOpen} />)
  }
}

describe('PastedImageStrip', () => {
  it('draws nothing when the prompt holds no images', () => {
    const { container } = strip('empty', [])
    expect(container.firstChild).toBeNull()
  })

  it('shows every image, each opening the full view', async () => {
    const { onOpen } = strip('shows', [one, two])
    expect(screen.getByRole('button', { name: 'Image 1' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Image 2' }))
    expect(onOpen).toHaveBeenCalledWith(two)
  })

  it('takes one image off and keeps it off while the prompt still holds it', async () => {
    const { rerenderWith } = strip('removes', [one, two])
    await userEvent.click(screen.getByRole('button', { name: 'Remove image 2' }))
    expect(screen.queryByRole('button', { name: 'Image 2' })).toBeNull()
    rerenderWith([one, two])
    expect(screen.queryByRole('button', { name: 'Image 2' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Image 1' })).toBeTruthy()
  })

  it('shows a new session’s image under the number that was taken off', async () => {
    const { rerenderWith } = strip('new-session', [one])
    await userEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    rerenderWith([{ ...one, url: 'teamree-file://n/1', path: '/t/n/images/1.png' }])
    expect(screen.getByRole('button', { name: 'Image 1' })).toBeTruthy()
  })

  it('minimizes to a count and expands again', async () => {
    strip('minimizes', [one, two])
    await userEvent.click(screen.getByRole('button', { name: 'Minimize images' }))
    expect(screen.queryByRole('button', { name: 'Image 1' })).toBeNull()
    const chip = screen.getByRole('button', { name: '2 images' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(chip)
    expect(screen.getByRole('button', { name: 'Image 1' })).toBeTruthy()
  })

  it('remembers a minimized strip per pane across a remount', async () => {
    const first = strip('remembers', [one])
    await userEvent.click(screen.getByRole('button', { name: 'Minimize images' }))
    expect(screen.getByRole('button', { name: '1 image' })).toBeTruthy()
    first.unmount()
    strip('remembers', [one, two])
    expect(screen.getByRole('button', { name: '2 images' })).toBeTruthy()
    cleanup()
    strip('another-pane', [one])
    expect(screen.getByRole('button', { name: 'Image 1' })).toBeTruthy()
  })

  it('keeps the keyboard in the strip when its controls swap', async () => {
    strip('keyboard', [one, two])
    screen.getByRole('button', { name: 'Minimize images' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '2 images' }))
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Minimize images' }))
    screen.getByRole('button', { name: 'Remove image 1' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove image 2' }))
  })

  it('does not take focus from the terminal on a click', () => {
    strip('mouse', [one])
    const pressed = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    screen.getByRole('button', { name: 'Remove image 1' }).dispatchEvent(pressed)
    expect(pressed.defaultPrevented).toBe(true)
  })
})
