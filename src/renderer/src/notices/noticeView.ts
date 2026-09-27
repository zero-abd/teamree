// What a notice's card says and how it is coloured, from its text, tone and action.

import type { IconName } from '../icons/Icon'
import type { Notice } from '../state/workspaceStore'

/** The part before the first `: ` as the title and the rest as the detail; a short head only, or it is one title. */
export function noticeParts(text: string): { title: string; detail: string | null } {
  const at = text.indexOf(': ')
  if (at <= 0 || at > TITLE_MAX || text.slice(at + 2).trim() === '') return { title: text, detail: null }
  return { title: text.slice(0, at), detail: text.slice(at + 2) }
}

const TITLE_MAX = 60

export type NoticeLook = 'error' | 'success' | 'info'

/** An error is red; news that can be undone is something done, green; the rest is neutral. */
export function noticeLook(notice: Pick<Notice, 'tone' | 'action'>): NoticeLook {
  if (notice.tone === 'error') return 'error'
  return notice.action !== undefined && 'undo' in notice.action ? 'success' : 'info'
}

export const NOTICE_ICON: Record<NoticeLook, IconName> = { error: 'alert', success: 'check', info: 'info' }
