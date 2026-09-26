/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoticeTest } from './NoticeTest'

function bridge(result: string) {
  const notices = { test: vi.fn(async () => result), openSettings: vi.fn() }
  ;(window as unknown as { teamree: unknown }).teamree = { platform: 'darwin', notices }
  return notices
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('NoticeTest', () => {
  it('sends a test and offers the OS settings', async () => {
    const notices = bridge('blocked')
    render(<NoticeTest />)
    fireEvent.click(screen.getByRole('button', { name: 'Send Test' }))
    expect(await screen.findByText('Blocked by macOS')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(notices.test).toHaveBeenCalledOnce()
    expect(notices.openSettings).toHaveBeenCalledOnce()
  })

  it('says so when notifications are off', async () => {
    bridge('off')
    render(<NoticeTest />)
    fireEvent.click(screen.getByRole('button', { name: 'Send Test' }))
    expect(await screen.findByText('Notifications are off')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull()
  })

  it('shows nothing without the bridge', () => {
    const { container } = render(<NoticeTest />)
    expect(container.innerHTML).toBe('')
  })
})
