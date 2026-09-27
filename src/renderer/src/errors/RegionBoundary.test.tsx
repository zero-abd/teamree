/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RegionBoundary } from './RegionBoundary'

const report = vi.fn<(details: string) => void>()
const faults = { broken: true }

function Fragile(): React.JSX.Element {
  if (faults.broken) throw new Error('region broke')
  return <div>region content</div>
}

beforeEach(() => {
  faults.broken = true
  report.mockReset()
  ;(window as unknown as { teamree: unknown }).teamree = { errors: { report, onMainError: () => () => {} } }
  // React prints every caught render error; the boundary is the thing under test.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'teamree')
})

describe('a region that throws while rendering', () => {
  it('is replaced by a terse line, and the rest of the window stays', () => {
    render(
      <>
        <RegionBoundary region="sidebar">
          <Fragile />
        </RegionBoundary>
        <div>workspace</div>
      </>
    )
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
    expect(screen.getByText('workspace')).toBeTruthy()
    expect(report).toHaveBeenCalledWith(expect.stringContaining('region broke'))
    expect(report.mock.calls[0]?.[0]).toContain('sidebar')
  })

  it('comes back on Retry once it renders again', () => {
    render(
      <RegionBoundary region="workspace">
        <Fragile />
      </RegionBoundary>
    )
    faults.broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText('region content')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('copies its details', () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(
      <RegionBoundary region="workspace">
        <Fragile />
      </RegionBoundary>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy Details' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('region broke'))
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('offers Close in place of Retry where it can be dismissed, and starts over for a new key', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <RegionBoundary region="dialog" resetKey="a" onDismiss={onDismiss}>
        <Fragile />
      </RegionBoundary>
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    faults.broken = false
    rerender(
      <RegionBoundary region="dialog" resetKey="b" onDismiss={onDismiss}>
        <Fragile />
      </RegionBoundary>
    )
    expect(screen.getByText('region content')).toBeTruthy()
  })

  it('works without the bridge', () => {
    Reflect.deleteProperty(window, 'teamree')
    render(
      <RegionBoundary region="window">
        <Fragile />
      </RegionBoundary>
    )
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
