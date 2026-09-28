// The rows of `setupModel`, each with its buttons, for Setup…; the welcome's version keeps only rows that need action.

import { useEffect, useState } from 'react'
import { Select } from '../ui/Select'
import { HARNESSES } from '../agents/harnesses'
import type { NoticeTestResult } from '../notices/noticeTestModel'
import { NO_DEFAULT_AGENT } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Icon } from '../icons/Icon'
import { offersDefaultAgent, setupRows, setupSummary, type SetupAction, type SetupRow } from './setupModel'

const STATE_LABEL: Record<SetupRow['state'], string> = {
  done: 'Done',
  todo: 'Needs action',
  waiting: 'Checking',
  elsewhere: 'Another copy'
}

function useSetupRows(): { rows: SetupRow[]; run: (action: SetupAction) => void } {
  const agents = useWorkspaceStore((state) => state.agents)
  const agentsProbed = useWorkspaceStore((state) => state.agentsProbed)
  const notices = useWorkspaceStore((state) => state.agentNotices)
  const cli = useWorkspaceStore((state) => state.cli)
  const projects = useWorkspaceStore((state) => state.projects)
  const loadAgents = useWorkspaceStore((state) => state.loadAgents)
  const loadCli = useWorkspaceStore((state) => state.loadCli)
  const [noticeTest, setNoticeTest] = useState<NoticeTestResult | null>(null)

  // Asked on arrival: versions are not part of the startup probe, and the CLI may have been linked since.
  useEffect(() => {
    void loadAgents()
    void loadCli()
  }, [loadAgents, loadCli])

  const bridge = typeof window === 'undefined' ? undefined : window.teamree
  const rows = setupRows({ agents, agentsProbed, notices, noticeTest, platform: bridge?.platform ?? '', cli, projects })
    // Only where the bridge can raise one.
    .map((row) => ({ ...row, actions: row.actions.filter((action) => action.id !== 'send-test' || bridge?.notices) }))

  const run = (action: SetupAction): void => {
    const store = useWorkspaceStore.getState()
    switch (action) {
      case 'recheck-agents':
        void loadAgents({ fresh: true })
        break
      case 'send-test':
        void bridge?.notices.test().then(setNoticeTest, () => setNoticeTest(null))
        break
      case 'turn-on-notices':
        setNoticeTest(null)
        store.setAgentNotices('notify')
        break
      case 'notice-settings':
        bridge?.notices.openSettings()
        break
      case 'install-cli':
        // The panel makes the link; the corner card is not asked again.
        store.openDialog({ kind: 'install-cli' })
        void store.dismissCliPrompt()
        break
      case 'new-project':
        void store.newProject()
        break
      case 'open-folder':
        void store.chooseProjectFolder()
        break
      case 'clone':
        store.openDialog({ kind: 'clone-project' })
        break
      case 'join':
        store.openDialog({ kind: 'join-invitation' })
        break
    }
  }

  return { rows, run }
}

function SetupRowItem({ row, run }: { row: SetupRow; run: (action: SetupAction) => void }): React.JSX.Element {
  const agents = useWorkspaceStore((state) => state.agents)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  return (
    <li className="setup__row" data-setup={row.id} data-state={row.state}>
      <span className={`setup__mark setup__mark--${row.state}`} role="img" aria-label={STATE_LABEL[row.state]} />
      <span className="setup__label">{row.label}</span>
      <span className="setup__value">
        {row.chips.map((chip) => (
          <span key={chip} className="chip setup__chip">
            {chip}
          </span>
        ))}
        {row.value === null ? null : <span role={row.id === 'notifications' ? 'status' : undefined}>{row.value}</span>}
      </span>
      <span className="setup__actions">
        {row.id === 'agents' && offersDefaultAgent(agents) ? (
          <label className="setup__picker">
            Default
            <Select
              aria-label="Default agent"
              value={defaultAgent}
              onChange={(event) => useWorkspaceStore.getState().setDefaultAgent(event.target.value)}
            >
              <option value={NO_DEFAULT_AGENT}>First found</option>
              {agents.map((agent) => (
                <option key={agent.kind} value={agent.kind}>
                  {HARNESSES[agent.kind].name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {row.actions.map((action) => (
          <button key={action.id} type="button" className="button button--small" onClick={() => run(action.id)}>
            {action.label}
          </button>
        ))}
      </span>
    </li>
  )
}

export function SetupRows(): React.JSX.Element {
  const { rows, run } = useSetupRows()
  return (
    <ul className="setup">
      {rows.map((row) => (
        <SetupRowItem key={row.id} row={row} run={run} />
      ))}
    </ul>
  )
}

/** The welcome's: a row only for what needs action, then one quiet line of what works, with Setup… for the rest. */
export function SetupSummary({ except }: { except?: SetupRow['id'] }): React.JSX.Element {
  const { rows, run } = useSetupRows()
  const agents = useWorkspaceStore((state) => state.agents)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const { needsAction, working } = setupSummary(
    rows.filter((row) => row.id !== except),
    agents
  )
  return (
    <>
      {needsAction.length === 0 ? null : (
        <ul className="setup">
          {needsAction.map((row) => (
            <SetupRowItem key={row.id} row={row} run={run} />
          ))}
        </ul>
      )}
      <div className="welcome__status">
        {working.map((name) => (
          <span key={name} className="welcome__check">
            <Icon name="check" size={14} />
            {name}
          </span>
        ))}
        <button
          type="button"
          className="button button--ghost button--tiny"
          onClick={() => openDialog({ kind: 'setup' })}
        >
          Setup…
        </button>
      </div>
    </>
  )
}
