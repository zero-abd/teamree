/** What main answers a Send Test with; a copy of `NoticeTestResult` in src/main/agentNotices.ts. */
export type NoticeTestResult = 'sent' | 'off' | 'blocked'

export type NoticeTestStatus = { text: string; openSettings: boolean }

/** The line beside Send Test, and whether to offer the OS settings (only where main has a page to open). */
export function noticeTestStatus(result: NoticeTestResult | null, platform: string): NoticeTestStatus | null {
  const settings = platform === 'darwin' || platform === 'win32'
  if (result === 'sent') return { text: 'Sent', openSettings: settings }
  if (result === 'off') return { text: 'Notifications are off', openSettings: false }
  if (result === 'blocked') {
    return { text: platform === 'darwin' ? 'Blocked by macOS' : 'Blocked by the system', openSettings: settings }
  }
  return null
}
