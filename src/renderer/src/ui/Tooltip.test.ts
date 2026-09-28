/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTooltips, placeTooltip, TOOLTIP_DELAY_MS, TOOLTIP_ID, TOOLTIP_WARM_MS } from './Tooltip'

let stop: () => void

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = `
    <span id="behind" data-tip="48 commits behind origin/master">↓48</span>
    <span id="changed" data-tip="115 changed files">Δ115</span>
    <button id="help" type="button" aria-label="Help" data-tip="Help">?</button>
    <button id="plain" type="button">Plain</button>
    <p id="text">words</p>`
  stop = installTooltips(document)
})

afterEach(() => {
  stop()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const tip = (): HTMLElement | null => document.querySelector('[role="tooltip"]')
const wait = (ms: number): void => {
  vi.advanceTimersByTime(ms)
}

describe('tooltips', () => {
  it('shows after the delay, not before, and goes when the pointer leaves', () => {
    fireEvent.pointerOver(byId('behind'))
    wait(TOOLTIP_DELAY_MS - 1)
    expect(tip()).toBeNull()
    wait(1)
    expect(tip()?.textContent).toBe('48 commits behind origin/master')
    fireEvent.pointerOver(byId('text'))
    expect(tip()).toBeNull()
  })

  it('shows the neighbour at once while warm, and waits again once cold', () => {
    fireEvent.pointerOver(byId('behind'))
    wait(TOOLTIP_DELAY_MS)
    fireEvent.pointerOver(byId('changed'))
    expect(tip()?.textContent).toBe('115 changed files')
    fireEvent.pointerOver(byId('text'))
    wait(TOOLTIP_WARM_MS + 1)
    fireEvent.pointerOver(byId('behind'))
    expect(tip()).toBeNull()
    wait(TOOLTIP_DELAY_MS)
    expect(tip()?.textContent).toBe('48 commits behind origin/master')
  })

  it('keeps one tooltip in the document however many targets there are', () => {
    fireEvent.pointerOver(byId('behind'))
    wait(TOOLTIP_DELAY_MS)
    fireEvent.pointerOver(byId('changed'))
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  })

  it('describes its target, and leaves an element alone whose name already says it', () => {
    fireEvent.pointerOver(byId('behind'))
    wait(TOOLTIP_DELAY_MS)
    expect(byId('behind').getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(tip()?.id).toBe(TOOLTIP_ID)
    fireEvent.pointerOver(byId('help'))
    expect(byId('behind').hasAttribute('aria-describedby')).toBe(false)
    expect(tip()?.textContent).toBe('Help')
    expect(byId('help').hasAttribute('aria-describedby')).toBe(false)
  })

  it('shows on keyboard focus and goes on blur, but not on a focus the pointer caused', () => {
    byId('help').focus()
    wait(TOOLTIP_DELAY_MS)
    expect(tip()?.textContent).toBe('Help')
    byId('plain').focus()
    expect(tip()).toBeNull()
    fireEvent.pointerDown(byId('help'))
    byId('help').focus()
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toBeNull()
  })

  it('goes on Escape without taking the key, and stays gone until the pointer moves on', () => {
    const heard = vi.fn()
    document.addEventListener('keydown', heard)
    fireEvent.pointerOver(byId('behind'))
    wait(TOOLTIP_DELAY_MS)
    fireEvent.keyDown(byId('behind'), { key: 'Escape' })
    expect(tip()).toBeNull()
    expect(heard).toHaveBeenCalled()
    fireEvent.pointerOver(byId('behind').firstChild ?? byId('behind'))
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).toBeNull()
    fireEvent.pointerOver(byId('text'))
    fireEvent.pointerOver(byId('behind'))
    wait(TOOLTIP_DELAY_MS)
    expect(tip()).not.toBeNull()
    document.removeEventListener('keydown', heard)
  })

  it('follows a count that changes while it shows', () => {
    fireEvent.pointerOver(byId('changed'))
    wait(TOOLTIP_DELAY_MS)
    byId('changed').dataset.tip = '1 changed file'
    return Promise.resolve().then(() => expect(tip()?.textContent).toBe('1 changed file'))
  })

  it('flips over a target at the bottom of the window', () => {
    const bar = byId('changed')
    bar.getBoundingClientRect = () => new DOMRect(600, 880, 60, 20)
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 24 })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 120 })
    try {
      fireEvent.pointerOver(bar)
      wait(TOOLTIP_DELAY_MS)
      expect(tip()?.dataset.side).toBe('above')
      expect(tip()?.style.top).toBe(`${880 - 6 - 24}px`)
    } finally {
      delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
      delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
    }
  })
})

describe('placeTooltip', () => {
  const view = { width: 1440, height: 900 }
  const size = { width: 180, height: 24 }
  const covers = (target: { left: number; top: number; right: number; bottom: number }): boolean => {
    const at = placeTooltip(target, size, view)
    return (
      at.left < target.right &&
      at.left + size.width > target.left &&
      at.top < target.bottom &&
      at.top + size.height > target.top
    )
  }

  it('sits centred under its target', () => {
    expect(placeTooltip({ left: 100, top: 100, right: 140, bottom: 120 }, size, view)).toEqual({
      left: 30,
      top: 126,
      side: 'below'
    })
  })

  it('flips over a target at the bottom edge', () => {
    expect(placeTooltip({ left: 700, top: 876, right: 760, bottom: 900 }, size, view).side).toBe('above')
  })

  it('stays inside the left and right edges', () => {
    expect(placeTooltip({ left: 0, top: 10, right: 20, bottom: 30 }, size, view).left).toBe(8)
    expect(placeTooltip({ left: 1420, top: 10, right: 1440, bottom: 30 }, size, view).left).toBe(1440 - 8 - 180)
  })

  it('never covers its target, whichever corner it is in', () => {
    for (const target of [
      { left: 0, top: 0, right: 24, bottom: 24 },
      { left: 1416, top: 0, right: 1440, bottom: 24 },
      { left: 0, top: 874, right: 24, bottom: 900 },
      { left: 1416, top: 874, right: 1440, bottom: 900 },
      { left: 700, top: 440, right: 740, bottom: 460 }
    ]) {
      expect(covers(target)).toBe(false)
    }
  })
})
