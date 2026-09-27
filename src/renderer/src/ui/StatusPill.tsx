// A pane's lifecycle state as a dot, or a dot and its word: the dot carries the hue, the ground stays neutral.

export type PaneState = 'starting' | 'working' | 'asking' | 'ready' | 'ended' | 'failed' | 'restored'

const WORD: Record<PaneState, string> = {
  starting: 'starting',
  working: 'working',
  asking: 'asking',
  ready: 'ready',
  ended: 'ended',
  failed: 'failed',
  restored: 'restored'
}

export function StatusDot({ state }: { state: PaneState }): React.JSX.Element {
  return <span className={`status-dot status--${state}`} role="img" aria-label={WORD[state]} />
}

/** The state named beside its dot; `label` replaces the word, e.g. "exit 1". */
export function StatusPill({ state, label }: { state: PaneState; label?: string }): React.JSX.Element {
  return (
    <span className={`chip status-pill status--${state}`}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-pill__label">{label ?? WORD[state]}</span>
    </span>
  )
}
