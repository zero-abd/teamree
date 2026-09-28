// A count per installed agent, stepped with − and +. `most` caps the total: a
// branch opened as it is can hold one checkout, so one agent. With `onMode`, a
// selected agent that has permission modes shows them beside its count.

import type { InstalledAgent } from '@shared/entities'
import { permissionArgs, permissionModesFor, type PermissionMode } from '@shared/permissionMode'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { Stepper } from '../ui/Stepper'
import { agentCount, MAX_PER_AGENT, withAgentCount, type AgentCounts, type AgentModes } from './taskPlan'

const MODE_LABEL: Readonly<Record<PermissionMode, string>> = { default: 'Default', auto: 'Auto', bypass: 'Bypass' }

export function AgentSteppers({
  agents,
  counts,
  onChange,
  most,
  modes = {},
  onMode
}: {
  agents: readonly InstalledAgent[]
  counts: AgentCounts
  onChange: (counts: AgentCounts) => void
  most?: number
  modes?: AgentModes
  onMode?: (kind: string, mode: PermissionMode) => void
}): React.JSX.Element | null {
  if (agents.length === 0) return null
  const total = agents.reduce((sum, entry) => sum + agentCount(counts, entry.kind), 0)
  return (
    <fieldset className="field agents">
      <legend className="field__label">Agents</legend>
      {agents.map((entry) => {
        const count = agentCount(counts, entry.kind)
        const step = (to: number): void => onChange(withAgentCount(counts, entry.kind, to))
        const offered = onMode === undefined || count === 0 ? [] : permissionModesFor(entry.kind)
        const chosen = modes[entry.kind] ?? 'default'
        return (
          <div className="agents__row" key={entry.kind}>
            <span className="agents__name">
              {/* The name beside it says it once; the mark's own label would say it twice. */}
              <span aria-hidden="true" className="agents__mark">
                <AgentGlyph kind={entry.kind} decorative />
              </span>
              {harnessName(entry.kind)}
            </span>
            {offered.length > 0 ? (
              <div
                className="segmented agents__modes"
                role="radiogroup"
                aria-label={`${harnessName(entry.kind)} permissions`}
              >
                {offered.map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    role="radio"
                    aria-checked={mode === chosen}
                    title={permissionArgs(entry.kind, mode) || undefined}
                    className={`segmented__item agents__mode agents__mode--${mode}`}
                    onClick={() => onMode?.(entry.kind, mode)}
                  >
                    {MODE_LABEL[mode]}
                  </button>
                ))}
              </div>
            ) : null}
            <Stepper
              label={harnessName(entry.kind)}
              value={count}
              max={most === undefined ? MAX_PER_AGENT : Math.min(MAX_PER_AGENT, count + Math.max(0, most - total))}
              onChange={step}
            />
          </div>
        )
      })}
    </fieldset>
  )
}
