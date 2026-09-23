// A pane's mark: the harness it runs, or a terminal.

import type { AgentKind } from '@shared/entities'
import { HARNESSES, harnessName, type Harness } from './harnesses'

/** The harness's mark, named for screen readers; a neutral mark for a kind with no entry. */
export function AgentGlyph({ kind }: { kind: AgentKind }): React.JSX.Element {
  const harness = HARNESSES[kind] as Harness | undefined
  const name = harnessName(kind)
  return (
    <svg className="agent-glyph" viewBox="0 0 24 24" role="img" aria-label={name} data-agent={kind}>
      <title>{name}</title>
      <path d={harness?.path ?? NEUTRAL_PATH} fillRule={harness?.evenOdd === true ? 'evenodd' : undefined} />
    </svg>
  )
}

// A four-point star: no brand's, so it cannot be mistaken for one.
const NEUTRAL_PATH = 'M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z'

/** A plain shell's mark. Decorative: the row's text already names the shell. */
export function TerminalGlyph(): React.JSX.Element {
  return (
    <svg className="agent-glyph agent-glyph--terminal" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2 4h20v16H2ZM3.6 5.6v12.8h16.8V5.6ZM6 9.2l1.1-1.1L11 12l-3.9 3.9L6 14.8 8.8 12Zm6 5.3h6v1.6h-6Z"
        fillRule="evenodd"
      />
    </svg>
  )
}

/** A pane's mark: its harness when one is known, the terminal otherwise. */
export function PaneGlyph({ agent }: { agent: AgentKind | undefined }): React.JSX.Element {
  return agent === undefined ? <TerminalGlyph /> : <AgentGlyph kind={agent} />
}
