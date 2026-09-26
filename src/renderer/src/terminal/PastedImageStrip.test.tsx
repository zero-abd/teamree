/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PastedImageStrip } from './PastedImageStrip'
import type { ShownImage } from './paneImageLinks'
import type { NotRemoved } from './promptEdit'

afterEach(cleanup)

const one: ShownImage = { index: 1, url: 'teamree-file://s/1', path: '/t/s/images/1.png' }
const two: ShownImage = { index: 2, url: 'teamree-file://s/2', path: '/t/s/images/2.png' }

function strip(
  terminalId: string,
  images: ShownImage[],
  onOpen = vi.fn(),
  onRemove = vi.fn(async (_image: ShownImage): Promise<NotRemoved | null> => null)
) {
  const props = { terminalId, onOpen, onRemove }
  const view = render(<PastedImageStrip {...props} images={images} />)
  return {
    ...view,
    onOpen,
    onRemove,
    rerenderWith: (next: ShownImage[]) => view.rerender(<PastedImageStrip {...props} images={next} />)
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

  it('asks the pane to take the image out of the prompt, and says what × does', async () => {
    const { onRemove } = strip('removes', [one, two])
    const remove = screen.getByRole('button', { name: 'Remove image 2' })
    expect(remove.getAttribute('title')).toBe('Remove from prompt')
    await userEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith(two)
  })

  it('keeps the thumbnail and says why when the image stayed in the prompt', async () => {
    const { onRemove } = strip('kept', [one, two], vi.fn(), vi.fn(async () => 'busy' as const))
    await userEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('Image 1 not removed: agent busy')
    expect(screen.getByRole('button', { name: 'Image 1' })).toBeTruthy()
  })

  it('takes one removal at a time', async () => {
    let finish: (outcome: NotRemoved | null) => void = () => {}
    const pending = vi.fn(() => new Promise<NotRemoved | null>((resolve) => (finish = resolve)))
    strip('one-at-a-time', [one, two], vi.fn(), pending)
    await userEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove image 2' }))
    expect(pending).toHaveBeenCalledTimes(1)
    await act(async () => finish(null))
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
  })

  it('moves the keyboard to the next × once the image leaves the prompt', async () => {
    const { rerenderWith } = strip('keyboard-remove', [one, two])
    screen.getByRole('button', { name: 'Remove image 1' }).focus()
    await userEvent.keyboard('{Enter}')
    rerenderWith([two])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove image 2' }))
  })

  it('does not take focus from the terminal on a click', () => {
    strip('mouse', [one])
    const pressed = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    screen.getByRole('button', { name: 'Remove image 1' }).dispatchEvent(pressed)
    expect(pressed.defaultPrevented).toBe(true)
  })
})
