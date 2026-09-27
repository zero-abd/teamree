/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import { watchWindowErrors } from './windowErrors'

function rejection(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection'), { reason })
}

describe('errors nothing caught in the window', () => {
  it('are reported with their stack, uncaught and unhandled alike', () => {
    const report = vi.fn<(details: string) => void>()
    const target = new EventTarget()
    watchWindowErrors(target, report)
    target.dispatchEvent(new ErrorEvent('error', { error: new TypeError('x is undefined'), message: 'x is undefined' }))
    target.dispatchEvent(rejection(new Error('fetch failed')))
    target.dispatchEvent(rejection('plain reason'))
    expect(report).toHaveBeenCalledTimes(3)
    expect(report.mock.calls[0]?.[0]).toContain('TypeError: x is undefined')
    expect(report.mock.calls[1]?.[0]).toContain('unhandled rejection')
    expect(report.mock.calls[1]?.[0]).toContain('fetch failed')
    expect(report.mock.calls[2]?.[0]).toContain('plain reason')
  })

  // Chromium's own notice that a resize callback was deferred, not a fault.
  it('leave out the ResizeObserver loop notice', () => {
    const report = vi.fn<(details: string) => void>()
    const target = new EventTarget()
    watchWindowErrors(target, report)
    target.dispatchEvent(
      new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' })
    )
    expect(report).not.toHaveBeenCalled()
  })

  it('stop being reported once unwatched', () => {
    const report = vi.fn<(details: string) => void>()
    const target = new EventTarget()
    watchWindowErrors(target, report)()
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('late') }))
    expect(report).not.toHaveBeenCalled()
  })
})
