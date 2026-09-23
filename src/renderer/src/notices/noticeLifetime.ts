// How long a notice stays, decided from what it is.
//
// "Added repo" was still on screen twenty minutes and two dozen interactions
// later, stacked under every notice raised since, and nothing but the dismiss
// button ever retired one. News goes stale. So a notice that only reports
// something leaves on its own; one that carries an error stays, because an
// error unread is a thing that will happen again; and one that carries a
// button stays, because the button is the only place that offer exists.

import type { Notice } from '../state/workspaceStore'

/**
 * Long enough to read twice, short enough that a first session does not end
 * with a column of old news.
 */
export const NOTICE_LIFETIME_MS = 8_000

/** How long this notice stays, or null for as long as it takes to be dismissed. */
export function noticeLifetime(notice: Pick<Notice, 'tone' | 'action'>): number | null {
  if (notice.tone === 'error') return null
  if (notice.action !== undefined) return null
  return NOTICE_LIFETIME_MS
}
