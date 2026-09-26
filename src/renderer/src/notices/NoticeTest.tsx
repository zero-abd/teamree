import { useState } from 'react'
import { noticeTestStatus, type NoticeTestResult } from './noticeTestModel'

/** Send Test beside the notification setting, with what came of it. */
export function NoticeTest(): React.JSX.Element | null {
  const [result, setResult] = useState<NoticeTestResult | null>(null)
  // Absent without the preload (tests, a browser on the dev server).
  const notices = window.teamree?.notices
  if (!notices) return null
  const status = noticeTestStatus(result, window.teamree.platform)

  return (
    <>
      <button
        type="button"
        className="button button--small"
        onClick={() => void notices.test().then(setResult, () => setResult(null))}
      >
        Send Test
      </button>
      {status ? (
        <span className="settings-aside" role="status">
          {status.text}
        </span>
      ) : null}
      {status?.openSettings ? (
        <button type="button" className="button button--small" onClick={() => notices.openSettings()}>
          Open Settings
        </button>
      ) : null}
    </>
  )
}
