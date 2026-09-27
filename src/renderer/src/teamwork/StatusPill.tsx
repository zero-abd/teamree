// A state as a word on a neutral pill whose dot carries the hue. A local stand-in until `ui/StatusPill` lands.

import type { DotTone } from '../sidebar/agentRows'

export type PillTone = 'starting' | 'working' | 'asking' | 'ready' | 'ended' | 'failed' | 'idle'

const BY_TONE: Record<DotTone, PillTone> = {
  failed: 'failed',
  waiting: 'asking',
  working: 'working',
  quiet: 'ready',
  done: 'ready',
  idle: 'idle',
  stopped: 'ended'
}

/** A task stage's word, where it says more than the panes' tone. */
const BY_WORD: Readonly<Record<string, PillTone>> = {
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

export function pillTone(tone: DotTone | null, word?: string | null): PillTone {
  return (word == null ? undefined : BY_WORD[word]) ?? (tone === null ? 'idle' : BY_TONE[tone])
}

export function StatusPill({
  tone,
  className,
  children
}: {
  tone: PillTone
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className={`state-pill state-pill--${tone}${className === undefined ? '' : ` ${className}`}`}>
      {children}
    </span>
  )
}
