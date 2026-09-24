// A count per installed agent, stepped with − and +. `most` caps the total: a
// branch opened as it is can hold one checkout, so one agent.

import type { InstalledAgent } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { agentCount, MAX_PER_AGENT, withAgentCount, type AgentCounts } from './taskPlan'

export function AgentSteppers({
  agents,
  counts,
  onChange,
  most
}: {
  agents: readonly InstalledAgent[]
  counts: AgentCounts
  onChange: (counts: AgentCounts) => void
  most?: number
}): React.JSX.Element | null {
  if (agents.length === 0) return null
  const total = agents.reduce((sum, entry) => sum + agentCount(counts, entry.kind), 0)
  return (
    <fieldset className="field agents">
      <legend className="field__label">Agents</legend>
      {agents.map((entry) => {
        const count = agentCount(counts, entry.kind)
        const step = (to: number): void => onChange(withAgentCount(counts, entry.kind, to))
        return (
          <div className="agents__row" key={entry.kind}>
            <span className="agents__name">
              {/* The name beside it says it once; the mark's own label would say it twice. */}
              <span aria-hidden="true" className="agents__mark">
                <AgentGlyph kind={entry.kind} />
              </span>
              {harnessName(entry.kind)}
            </span>
            <button
              type="button"
              className="agents__step"
              aria-label={`One fewer ${harnessName(entry.kind)}`}
              disabled={count === 0}
              onClick={() => step(count - 1)}
            >
              −
            </button>
            <output className="agents__count">{count}</output>
            <button
              type="button"
              className="agents__step"
              aria-label={`One more ${harnessName(entry.kind)}`}
              disabled={count === MAX_PER_AGENT || (most !== undefined && total >= most)}
              onClick={() => step(count + 1)}
            >
              +
            </button>
          </div>
        )
      })}
    </fieldset>
  )
}
