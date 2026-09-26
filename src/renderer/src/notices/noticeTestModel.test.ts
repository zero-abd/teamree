import { describe, expect, it } from 'vitest'
import { noticeTestStatus } from './noticeTestModel'

describe('noticeTestStatus', () => {
  it('says sent, and offers the settings where the OS may still hide it', () => {
    expect(noticeTestStatus('sent', 'darwin')).toEqual({ text: 'Sent', openSettings: true })
    expect(noticeTestStatus('sent', 'linux')).toEqual({ text: 'Sent', openSettings: false })
  })

  it('says the OS blocked it, and offers its settings', () => {
    expect(noticeTestStatus('blocked', 'darwin')).toEqual({ text: 'Blocked by macOS', openSettings: true })
    expect(noticeTestStatus('blocked', 'win32')).toEqual({ text: 'Blocked by the system', openSettings: true })
  })

  it('says notifications are off, with nothing to open', () => {
    expect(noticeTestStatus('off', 'darwin')).toEqual({ text: 'Notifications are off', openSettings: false })
  })

  it('says nothing before a test, or without the bridge', () => {
    expect(noticeTestStatus(null, 'darwin')).toBeNull()
  })
})
