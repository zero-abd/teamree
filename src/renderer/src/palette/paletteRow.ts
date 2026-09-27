// How one palette row draws: its icon, which letters the query matched, and its status beside the project.

import type { AgentKind } from '@shared/entities'
import type { IconName } from '../icons/Icon'
import { TONE_LABEL, type DotTone } from '../sidebar/agentRows'
import { trailing, type PaletteItem } from './paletteModel'

export type LabelPart = { text: string; match: boolean }

/** The label cut into runs, the ones the query matched marked; the same ranking rules as `score`. */
export function highlight(label: string, query: string): LabelPart[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return [{ text: label, match: false }]
  const haystack = label.toLowerCase()
  const marks = Array.from({ length: label.length }, () => false)
  const mark = (from: number, length: number): void => {
    for (let index = from; index < from + length; index += 1) marks[index] = true
  }

  const whole = wordStartOrFirst(haystack, wanted)
  if (whole !== -1) mark(whole, wanted.length)
  else {
    for (const word of wanted.split(/\s+/)) {
      const at = wordStartOrFirst(haystack, word)
      if (at !== -1) mark(at, word.length)
      else for (const initial of initialsOf(haystack, word)) mark(initial, 1)
    }
  }

  const parts: LabelPart[] = []
  for (let index = 0; index < label.length; index += 1) {
    const last = parts[parts.length - 1]
    const match = marks[index] === true
    if (last !== undefined && last.match === match) last.text += label[index]
    else parts.push({ text: label[index] as string, match })
  }
  return parts
}

function wordStartOrFirst(haystack: string, word: string): number {
  const first = haystack.indexOf(word)
  for (let index = first; index !== -1; index = haystack.indexOf(word, index + 1)) {
    if (isWordStart(haystack, index)) return index
  }
  return first
}

/** Where `word` runs down the initials of consecutive words, or none. */
function initialsOf(haystack: string, word: string): number[] {
  if (word.length < 2) return []
  const starts: number[] = []
  for (let index = 0; index < haystack.length; index += 1) {
    if (haystack[index] !== ' ' && isWordStart(haystack, index)) starts.push(index)
  }
  for (let from = 0; from + word.length <= starts.length; from += 1) {
    const run = starts.slice(from, from + word.length)
    if (run.every((at, step) => haystack[at] === word[step])) return run
  }
  return []
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  return ' /-_.'.includes(text[index - 1] as string)
}

export type RowIcon = { icon: IconName } | { agent: AgentKind }

const COMMAND_ICONS: Readonly<Record<string, IconName>> = {
  'new-worktree': 'new-task',
  'new-child-task': 'new-task',
  'new-task-from-issue': 'new-task',
  'new-terminal': 'terminal',
  'install-cli': 'terminal',
  'new-markdown': 'page',
  'quick-note': 'page',
  'show-decisions': 'page',
  'split-right': 'split-right',
  'split-down': 'split-down',
  'close-pane': 'close',
  'reopen-closed-pane': 'restore',
  'save-file': 'check',
  'save-all': 'check',
  'keep-run': 'check',
  'add-project': 'open-folder',
  'clone-repository': 'clone',
  'join-team': 'team',
  'open-settings': 'settings',
  'open-setup': 'settings',
  'open-appearance': 'appearance',
  'open-help': 'help',
  'open-dashboard': 'all-panes',
  'search-in-files': 'search',
  'search-contents': 'search',
  'find-in-pane': 'search',
  'filter-sidebar': 'filter',
  'go-to-file': 'file',
  'show-files': 'file',
  'go-to-line': 'file-text',
  'toggle-sidebar': 'sidebar-toggle',
  'toggle-right-panel': 'panel-show',
  'toggle-changes': 'changes',
  'review-changes': 'changes',
  'commit-changes': 'changes',
  'push-worktree': 'branch',
  'open-branch': 'branch',
  'open-pull-request': 'branch',
  'create-pull-request': 'branch',
  'merge-into-base': 'merge-clean',
  'resolve-conflicts': 'merge-conflict',
  'expand-pane': 'maximize',
  'toggle-diff-wrap': 'wrap',
  'toggle-diff-whitespace': 'whitespace',
  'toggle-markdown-source': 'md-code',
  'show-ports': 'plug',
  'check-for-updates': 'download',
  'toggle-automatic-updates': 'download',
  'rename-worktree': 'rename',
  'reveal-worktree': 'reveal',
  'copy-worktree-path': 'copy',
  'copy-worktree-branch': 'copy',
  'update-worktree': 'reload',
  'continue-update': 'play',
  'abort-update': 'stop',
  'remove-worktree': 'remove',
  'forget-worktree': 'remove',
  'discard-file': 'discard',
  'unstage-file': 'minimize',
  'resume-conversation': 'history'
}

const PREFIX_ICONS: Readonly<Record<string, IconName>> = {
  appearance: 'appearance',
  theme: 'appearance',
  'open-in': 'reveal',
  compare: 'diff-split',
  restore: 'restore',
  'clean-up': 'merge-clean',
  'push-base': 'branch',
  fetch: 'reload',
  teamwork: 'team',
  'shared-note': 'page',
  'new-task': 'new-task',
  'open-branch': 'branch',
  join: 'team',
  run: 'play',
  'restart-run': 'restart',
  'stop-run': 'stop',
  setting: 'settings'
}

/** The 16 px mark before a row's name. */
export function rowIcon(item: PaletteItem): RowIcon {
  switch (item.kind) {
    case 'worktree':
      return { icon: 'folder' }
    case 'file':
      return { icon: 'file' }
    case 'agent':
      return { icon: 'agent' }
    case 'pane':
      return item.agent === undefined ? { icon: 'terminal' } : { agent: item.agent }
    case 'action': {
      const colon = item.id.indexOf(':')
      const icon = colon === -1 ? COMMAND_ICONS[item.id] : PREFIX_ICONS[item.id.slice(0, colon)]
      return { icon: icon ?? 'chevron-right' }
    }
  }
}

/** The shared status class for a tone: the hue of its word. */
export const STATUS_CLASS: Record<DotTone, string> = {
  working: 'status--working',
  waiting: 'status--asking',
  failed: 'status--failed',
  quiet: 'status--ready',
  done: 'status--ready',
  stopped: 'status--ended',
  idle: 'status--ended'
}

/** The dot's tone, the state word said beside it (only where the row says one), and the rest of the right column. */
export function rowStatus(item: PaletteItem): { tone: DotTone | null; word: string | null; meta: string } {
  if (item.kind !== 'worktree' && item.kind !== 'pane') return { tone: null, word: null, meta: trailing(item) }
  const tone = item.tone ?? null
  const said = tone === null ? null : TONE_LABEL[tone]
  const parts = item.detail === '' ? [] : item.detail.split(' · ')
  const word = said !== null && parts.includes(said) ? said : null
  return { tone, word, meta: parts.filter((part) => part !== word).join(' · ') }
}
