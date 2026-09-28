// A machine with no coding agent: what to install, and Check Again once it is.

import { useId, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Button, IconButton } from '../ui/Button'
import { AGENT_INSTALLS, otherHarnessNames } from './agentInstalls'
import { AgentGlyph } from './glyphs'
import { harnessName } from './harnesses'

export function NoAgentFound(): React.JSX.Element {
  const loadAgents = useWorkspaceStore((state) => state.loadAgents)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)
  const [checking, setChecking] = useState(false)
  const title = useId()

  const check = (): void => {
    setChecking(true)
    void loadAgents({ fresh: true }).finally(() => setChecking(false))
  }

  return (
    <section className="no-agent" aria-labelledby={title}>
      <div className="no-agent__head">
        <span className="no-agent__title" id={title}>
          No coding agent found
        </span>
        <Button size="sm" loading={checking} disabled={checking} onClick={check}>
          Check Again
        </Button>
      </div>
      <ul className="no-agent__list">
        {AGENT_INSTALLS.map(({ kind, command }) => (
          <li className="no-agent__row" key={kind}>
            <span className="no-agent__mark">
              <AgentGlyph kind={kind} decorative />
            </span>
            <span className="no-agent__name">{harnessName(kind)}</span>
            <code className="no-agent__command">{command}</code>
            <IconButton
              icon="copy"
              size="sm"
              label={`Copy ${harnessName(kind)} install`}
              onClick={() => void copyToClipboard(command, `the ${harnessName(kind)} install`)}
            />
          </li>
        ))}
      </ul>
      <p className="no-agent__more">Also: {otherHarnessNames().join(' · ')}</p>
    </section>
  )
}
