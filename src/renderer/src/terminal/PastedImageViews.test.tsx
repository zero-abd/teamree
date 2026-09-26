/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PastedImagePeek, PastedImageViewer, peekPosition } from './PastedImageViews'

const IMAGE = { url: 'teamree-file://grant/t/2.png?v=1', path: '/tmp/claude-501/x/s/images/2.png', index: 2 }

describe('peekPosition', () => {
  it('sits below and right of the pointer', () => {
    expect(peekPosition(100, 100, 1200, 800)).toEqual({ left: 114, top: 114 })
  })

  it('flips above the pointer and stays inside the window at its edges', () => {
    expect(peekPosition(1190, 790, 1200, 800)).toEqual({ left: 930, top: 580 })
  })
})

describe('PastedImagePeek', () => {
  it('draws the thumbnail, and nothing once the image fails to load', () => {
    render(<PastedImagePeek peek={{ ...IMAGE, x: 10, y: 10 }} />)
    const image = document.querySelector('.image-peek img')
    expect(image?.getAttribute('src')).toBe(IMAGE.url)
    fireEvent.error(image as Element)
    expect(document.querySelector('.image-peek')).toBeNull()
  })
})

describe('PastedImageViewer', () => {
  it('shows the image under its placeholder name and closes on Escape', () => {
    const onClose = vi.fn()
    render(<PastedImageViewer image={IMAGE} onClose={onClose} />)

    expect(screen.getByRole('dialog', { name: 'Image #2' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Image #2' }).getAttribute('src')).toBe(IMAGE.url)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says the file is gone rather than drawing a broken image', () => {
    render(<PastedImageViewer image={IMAGE} onClose={() => {}} />)
    fireEvent.error(screen.getByRole('img', { name: 'Image #2' }))
    expect(screen.getByText('Gone from disk')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })
})
