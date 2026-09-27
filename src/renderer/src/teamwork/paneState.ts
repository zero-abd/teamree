// Which lifecycle state a row's pill shows, from the panes' tone or a task stage's word.

import type { DotTone } from '../sidebar/agentRows'
import type { PaneState } from '../ui/StatusPill'

const BY_TONE: Record<DotTone, PaneState> = {
  failed: 'failed',
  waiting: 'asking',
  working: 'working',
  quiet: 'ready',
  done: 'ready',
  idle: 'ended',
  stopped: 'ended'
}

/** A task stage's word, where it says more than the panes' tone. */
const BY_WORD: Readonly<Record<string, PaneState>> = {
  asking: 'asking',
  working: 'working',
  ready: 'ready',
  done: 'ready',
  merged: 'ready',
  landed: 'ready',
  finished: 'ready',
  failed: 'failed',
  missing: 'failed',
  stopped: 'ended'
}

export function paneState(tone: DotTone | null, word?: string | null): PaneState {
  return (word == null ? undefined : BY_WORD[word]) ?? (tone === null ? 'ended' : BY_TONE[tone])
}
