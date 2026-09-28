// What a notice's card says and how it is coloured, from its text, tone and action.

import type { IconName } from '../icons/Icon'
import type { ProjectBase } from '@shared/entities'
import type { Notice } from '../state/workspaceStore'

/** The part before the first `: ` as the title and the rest as the detail; a short head only, or it is one title. */
export function noticeParts(text: string): { title: string; detail: string | null } {
  const at = text.indexOf(': ')
  if (at <= 0 || at > TITLE_MAX || text.slice(at + 2).trim() === '') return { title: text, detail: null }
  return { title: text.slice(0, at), detail: text.slice(at + 2) }
}

const TITLE_MAX = 60

export type NoticeLook = 'error' | 'success' | 'neutral'

/** An error is red; news that can be undone is something done, green; the rest is neutral. */
export function noticeLook(notice: Pick<Notice, 'tone' | 'action'>): NoticeLook {
  if (notice.tone === 'error') return 'error'
  return notice.action !== undefined && 'undo' in notice.action ? 'success' : 'neutral'
}

export const NOTICE_ICON: Record<NoticeLook, IconName> = { error: 'alert', success: 'check', neutral: 'info' }

/** A landing's Undo only while main is still at the landing and unpushed; a base not read yet keeps it. */
export function liveAction(action: Notice['action'], bases: Readonly<Record<string, ProjectBase>>): Notice['action'] {
  if (action === undefined || !('undo' in action) || action.undo.kind !== 'land') return action
  const base = bases[action.undo.projectId]
  if (base === undefined) return action
  const moved = base.head !== undefined && base.head !== action.undo.head
  const pushed = base.upstream !== undefined && base.ahead === 0
  return moved || pushed ? undefined : action
}
