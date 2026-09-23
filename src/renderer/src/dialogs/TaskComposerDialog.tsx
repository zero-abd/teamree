// Starting work: describe the task, pick who does it (a count per agent, for racing attempts), and
// where from. One action makes the worktree and starts the agents; progress lives on the sidebar row.

import { useEffect, useState } from 'react'
import { MAX_AGENT_ARGS_CHARS } from '@shared/agentLaunch'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { useWorkspaceStore } from '../state/workspaceStore'
import { branchNameFromTask } from './branchNameFromTask'
import { Modal } from './Modal'
import { Chevron, StartPointPicker, type StartPointValue } from './StartPointPicker'
import {
  agentCount,
  defaultAgentCounts,
  fanOut,
  MAX_PER_AGENT,
  submitLabel,
  taskCreates,
  taskName,
  taskPlanNote,
  withAgentCount,
  type AgentCounts
} from './taskPlan'
import { useStartPoints } from './useStartPoints'

export function TaskComposerDialog({ projectId: openedFor }: { projectId: string }): React.JSX.Element | null {
  const projects = useWorkspaceStore((state) => state.projects)
  const agents = useWorkspaceStore((state) => state.agents)
  const agentsProbed = useWorkspaceStore((state) => state.agentsProbed)
  const startTask = useWorkspaceStore((state) => state.startTask)
  const startPointDefaults = useWorkspaceStore((state) => state.startPointDefaults)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [projectId, setProjectId] = useState(openedFor)
  const [task, setTask] = useState('')
  const [agentCounts, setAgentCounts] = useState<AgentCounts | null>(null)
  const [startPoint, setStartPoint] = useState<StartPointValue>({ text: '', option: null })
  const [touched, setTouched] = useState(false)

  const project = projects.find((entry) => entry.id === projectId)
  const { state: startPoints, reload } = useStartPoints(projectId)

  // The project's stored start ref wins over the base ref; otherwise the listing's base ref replaces
  // the placeholder as it lands. Nothing overwrites what the user typed.
  // Deps must stay `[startPoints, touched]`: adding `projectId` runs this with the previous project's
  // listing still in closure, putting the old base ref back into a box the select just cleared.
  useEffect(() => {
    if (touched || startPoints.phase !== 'ready') return
    const preferred = startPointDefaults[projectId]
    if (preferred !== undefined) {
      setStartPoint({
        text: preferred,
        option: startPoints.list.options.find((option) => option.ref === preferred) ?? null
      })
      return
    }
    const base = startPoints.list.options.find((option) => option.isBase) ?? null
    setStartPoint({ text: base?.ref ?? startPoints.list.baseRef, option: base })
  }, [startPoints, touched])

  if (!project) return null

  // Null until the user steps something, so the preselection never overwrites an early choice.
  const counts = agentCounts ?? defaultAgentCounts(agents, defaultAgent)
  const selection = fanOut(agents, counts)

  // Empty until there is text: the fallback slug "worktree" would promise an unrelated branch name.
  const branchName = task.trim() ? branchNameFromTask(taskName(task)) : ''
  const startedFrom = startPoint.text.trim()
  // Bounded by the agent's command line; a paste past it is refused, not cut.
  const tooLong = task.trim().length > MAX_AGENT_ARGS_CHARS
  const canSubmit = task.trim().length > 0 && !tooLong && startedFrom.length > 0

  const submit = (): void => {
    if (!canSubmit) return
    startTask({ projectId, startedFrom, creates: taskCreates(task, selection) })
  }

  return (
    <Modal title="New task" onClose={closeDialog}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="field field--task">
          <span className="field__label">Task</span>
          <textarea
            className="field__input field__input--task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            // Enter submits: this is the field people finish in.
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              submit()
            }}
            rows={3}
            placeholder="Rewrite the pager so it streams instead of buffering"
            autoComplete="off"
            spellCheck={true}
          />
          {tooLong ? (
            <span className="field__hint">
              {task.trim().length} / {MAX_AGENT_ARGS_CHARS} chars
            </span>
          ) : null}
        </label>

        {agents.length > 0 ? (
          <fieldset className="field agents">
            <legend className="field__label">Agents</legend>
            {agents.map((entry) => {
              const count = agentCount(counts, entry.kind)
              const step = (to: number): void => setAgentCounts(withAgentCount(counts, entry.kind, to))
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
                    disabled={count === MAX_PER_AGENT}
                    onClick={() => step(count + 1)}
                  >
                    +
                  </button>
                </div>
              )
            })}
          </fieldset>
        ) : null}

        <div className="form__row">
          <label className="field">
            <span className="field__label">Project</span>
            <span className="picker">
              <select
                className="field__input picker__input"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value)
                  // The old project's base ref has no meaning in the new one.
                  setTouched(false)
                  setStartPoint({ text: '', option: null })
                }}
              >
                {projects.map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <span className="picker__chevron">
                <Chevron />
              </span>
            </span>
          </label>
        </div>

        <StartPointPicker
          state={startPoints}
          onReload={reload}
          value={startPoint}
          onChange={(value) => {
            setTouched(true)
            setStartPoint(value)
          }}
          branchName={branchName}
        />

        <footer className="modal__actions">
          <p className="form__note">{taskPlanNote(agents, agentsProbed, selection)}</p>
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            {submitLabel(selection)}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
