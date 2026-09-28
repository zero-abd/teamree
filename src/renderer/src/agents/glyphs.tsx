// A pane's mark: the harness it runs, or a terminal.

import type { AgentKind } from '@shared/entities'
import { Icon } from '../icons/Icon'
import { HARNESSES, harnessName, type Harness } from './harnesses'

/**
 * The harness's mark, named for screen readers unless text beside it already names it; neutral for an unknown kind.
 * `tip` replaces the name in its tooltip, as a tab's `Claude Code · working`.
 */
export function AgentGlyph({
  kind,
  decorative = false,
  tip
}: {
  kind: AgentKind
  decorative?: boolean
  tip?: string
}): React.JSX.Element {
  const harness = HARNESSES[kind] as Harness | undefined
  const name = harnessName(kind)
  const tipped = tip === undefined ? {} : { 'data-tip': tip }
  // An unknown kind gets the set's star: no brand's, so it cannot be mistaken for one.
  if (harness === undefined)
    return (
      <Icon name="agent" className="agent-glyph" label={decorative ? undefined : name} data-agent={kind} {...tipped} />
    )
  const named = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name, 'data-tip': name }
  return (
    <svg className="agent-glyph" viewBox="0 0 24 24" {...named} {...tipped} data-agent={kind}>
      <path d={harness.path} fillRule={harness.evenOdd === true ? 'evenodd' : undefined} />
    </svg>
  )
}

/** A plain shell's mark. Decorative: the row's text already names the shell. */
export function TerminalGlyph({ tip }: { tip?: string }): React.JSX.Element {
  return (
    <Icon
      name="terminal"
      className="agent-glyph agent-glyph--terminal"
      {...(tip === undefined ? {} : { 'data-tip': tip })}
    />
  )
}

/** A pane's mark: its harness when one is known, the terminal otherwise. */
export function PaneGlyph({
  agent,
  decorative = false,
  tip
}: {
  agent: AgentKind | undefined
  decorative?: boolean
  tip?: string
}): React.JSX.Element {
  return agent === undefined ? (
    <TerminalGlyph tip={tip} />
  ) : (
    <AgentGlyph kind={agent} decorative={decorative} tip={tip} />
  )
}
