/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferWhileLayoutMoves, forgetDeferred, watchLayoutMotion } from './layoutMotion'

/** jsdom has no TransitionEvent; the fields read are set by hand. */
function transition(target: Element, type: string, propertyName: string): void {
  const event = new Event(type, { bubbles: true })
  Object.assign(event, { propertyName })
  target.dispatchEvent(event)
}

describe('layout motion', () => {
  let stop: () => void
  const shell = document.createElement('div')
  shell.className = 'shell'
  const panel = document.createElement('aside')
  panel.className = 'panel'
  const button = document.createElement('button')

  beforeEach(() => {
    document.body.append(shell, panel, button)
    stop = watchLayoutMotion(document)
  })
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('lets a fit through while nothing is moving', () => {
    expect(deferWhileLayoutMoves(() => {})).toBe(false)
  })

  // A pty told every frame's width makes a full-screen agent redraw every frame.
  it('holds a fit until the sidebar’s column stops moving, then runs it once', () => {
    const fit = vi.fn()
    transition(shell, 'transitionrun', 'grid-template-columns')
    expect(deferWhileLayoutMoves(fit)).toBe(true)
    expect(deferWhileLayoutMoves(fit)).toBe(true)
    transition(shell, 'transitionend', 'grid-template-columns')
    expect(fit).toHaveBeenCalledTimes(1)
    expect(deferWhileLayoutMoves(fit)).toBe(false)
  })

  it('waits for both edges when the panel and the sidebar move together', () => {
    const fit = vi.fn()
    transition(shell, 'transitionrun', 'grid-template-columns')
    transition(panel, 'transitionrun', 'width')
    deferWhileLayoutMoves(fit)
    transition(shell, 'transitioncancel', 'grid-template-columns')
    expect(fit).not.toHaveBeenCalled()
    transition(panel, 'transitionend', 'width')
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('ignores a colour fading on a button', () => {
    transition(button, 'transitionrun', 'width')
    transition(shell, 'transitionrun', 'background-color')
    expect(deferWhileLayoutMoves(() => {})).toBe(false)
  })

  it('drops a fit whose pane has gone', () => {
    const fit = vi.fn()
    transition(panel, 'transitionrun', 'width')
    deferWhileLayoutMoves(fit)
    forgetDeferred(fit)
    transition(panel, 'transitionend', 'width')
    expect(fit).not.toHaveBeenCalled()
  })

  // An element removed mid-transition sends no end.
  it('stops holding after a ceiling even when no end arrives', () => {
    vi.useFakeTimers()
    const fit = vi.fn()
    transition(panel, 'transitionrun', 'width')
    deferWhileLayoutMoves(fit)
    vi.advanceTimersByTime(1000)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(deferWhileLayoutMoves(fit)).toBe(false)
  })
})
