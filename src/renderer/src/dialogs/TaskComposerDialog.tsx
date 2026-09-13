// Starting work: describe the task, pick who does it, and where from.
//
// The unit of work is the task, not the checkout — so this is one action that
// creates the worktree and starts the agent in it, rather than a dialog that
// makes a directory and leaves the user to go and find an agent button. The
// description is the prominent field because it is the only one the user has to
// think about; everything else has a defensible default.
//
// Submitting closes the dialog at once. Creation is a background job and its
// progress, including its failures, belongs on the sidebar row.

import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { branchNameFromTask } from './branchNameFromTask'
import { Modal } from './Modal'
import { StartPointPicker, type StartPointValue } from './StartPointPicker'
import { agentByKind, defaultAgentKind, NO_AGENT, submitLabel, taskPlanNote } from './taskPlan'
import { useStartPoints } from './useStartPoints'

export function TaskComposerDialog({ projectId: openedFor }: { projectId: string }): React.JSX.Element | null {
  const projects = useWorkspaceStore((state) => state.projects)
  const agents = useWorkspaceStore((state) => state.agents)
  const agentsProbed = useWorkspaceStore((state) => state.agentsProbed)
  const startTask = useWorkspaceStore((state) => state.startTask)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [projectId, setProjectId] = useState(openedFor)
  const [task, setTask] = useState('')
  const [agentKind, setAgentKind] = useState<string | null>(null)
  const [startPoint, setStartPoint] = useState<StartPointValue>({ text: '', option: null })
  const [touched, setTouched] = useState(false)

  const project = projects.find((entry) => entry.id === projectId)
  const { state: startPoints, reload } = useStartPoints(projectId)

  // The listing lands after the dialog opens, so the base ref it names — and
  // the sha behind it — replace the placeholder, unless the user has already
  // put something of their own in the box. Switching project clears `touched`,
  // which is what lets the new project's base ref take over.
  useEffect(() => {
    if (touched || startPoints.phase !== 'ready') return
    const base = startPoints.list.options.find((option) => option.isBase) ?? null
    setStartPoint({ text: base?.ref ?? startPoints.list.baseRef, option: base })
  }, [startPoints, touched])

  if (!project) return null

  // Null until the user picks, so the first agent found is preselected without
  // overwriting a choice made while the probe was still in flight.
  const chosenKind = agentKind ?? defaultAgentKind(agents)
  const agent = agentByKind(agents, chosenKind)

  const branchName = branchNameFromTask(task)
  const startedFrom = startPoint.text.trim()
  const canSubmit = task.trim().length > 0 && startedFrom.length > 0

  const submit = (): void => {
    if (!canSubmit) return
    startTask({ projectId, task, startedFrom, ...(agent ? { agentCommand: agent.command } : {}) })
  }

  return (
    <Modal title="New task" description={project.name} onClose={closeDialog}>
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
            // Enter submits because this is the field people finish in; a
            // description long enough to need paragraphs still gets them.
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
          <span className="field__hint">
            branch <code>{branchName}</code> · Shift+Enter for a new line
          </span>
        </label>

        <div className="form__row">
          <label className="field">
            <span className="field__label">Agent</span>
            <select
              className="field__input"
              value={chosenKind}
              disabled={agents.length === 0}
              onChange={(event) => setAgentKind(event.target.value)}
            >
              {agents.map((entry) => (
                <option value={entry.kind} key={entry.kind} title={entry.binary}>
                  {entry.command}
                </option>
              ))}
              <option value={NO_AGENT}>No agent</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">Project</span>
            <select
              className="field__input"
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

        <footer className="form__actions">
          <p className="form__note">{taskPlanNote(agents, agentsProbed, agent)}</p>
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            {submitLabel(agent)}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
