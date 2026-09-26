// Starting work: describe the task, pick who does it (a count per agent, for racing attempts), and
// where from. One action makes the worktree and starts the agents; progress lives on the sidebar row.

import { useEffect, useState } from 'react'
import { MAX_AGENT_ARGS_CHARS } from '@shared/agentLaunch'
import { useWorkspaceStore } from '../state/workspaceStore'
import { AgentSteppers } from './AgentSteppers'
import { BranchField } from './BranchField'
import { branchNameFromTask } from './branchNameFromTask'
import { Modal } from './Modal'
import { Select } from './Select'
import { StartPointPicker, type StartPointValue } from './StartPointPicker'
import {
  branchProblem,
  defaultAgentCounts,
  fanOut,
  plannedBranches,
  submitLabel,
  taskCreates,
  taskName,
  taskPlanNote,
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
  const worktrees = useWorkspaceStore((state) => state.worktrees)

  const [projectId, setProjectId] = useState(openedFor)
  const [task, setTask] = useState('')
  const [agentCounts, setAgentCounts] = useState<AgentCounts | null>(null)
  const [startPoint, setStartPoint] = useState<StartPointValue>({ text: '', option: null })
  const [touched, setTouched] = useState(false)
  // A branch typed by hand, kept while the task is edited; null follows the task.
  const [branchEdit, setBranchEdit] = useState<string | null>(null)

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

  // Taken names: local branches the listing carries, and branches of worktrees the app already has.
  const existing = [
    ...(startPoints.phase === 'ready' ? startPoints.list.options : [])
      .filter((option) => option.kind === 'localBranch')
      .map((option) => option.refName ?? option.ref),
    ...worktrees.filter((worktree) => worktree.projectId === projectId).map((worktree) => worktree.branch)
  ]
  const hasTask = task.trim().length > 0
  const creates = taskCreates(task, selection, branchEdit?.trim() ?? '')
  const planned = hasTask ? plannedBranches(creates, existing) : []
  // One run shows its exact branch, suffix included; several show the stem their names share.
  const derived = !hasTask
    ? ''
    : creates.length > 1
      ? branchNameFromTask(taskName(task))
      : (plannedBranches(taskCreates(task, selection), existing)[0] ?? '')
  const problem = branchProblem(creates, existing)
  const startedFrom = startPoint.text.trim()
  // Bounded by the agent's command line; a paste past it is refused, not cut.
  const tooLong = task.trim().length > MAX_AGENT_ARGS_CHARS
  const canSubmit = hasTask && !tooLong && startedFrom.length > 0 && problem === null

  const submit = (): void => {
    if (!canSubmit) return
    startTask({ projectId, startedFrom, creates })
  }

  return (
    <Modal title="New Task" onClose={closeDialog}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          // The task box has already taken its own Enter.
          if (event.defaultPrevented || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
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
            placeholder="Task"
            autoComplete="off"
            spellCheck={true}
          />
          {tooLong ? (
            <span className="field__hint">
              {task.trim().length} / {MAX_AGENT_ARGS_CHARS} chars
            </span>
          ) : null}
        </label>

        <AgentSteppers agents={agents} counts={counts} onChange={setAgentCounts} />

        <div className="form__where">
          <label className="field">
            <span className="field__label">Project</span>
            <Select
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
            </Select>
          </label>
          <StartPointPicker
            state={startPoints}
            onReload={reload}
            value={startPoint}
            onChange={(value) => {
              setTouched(true)
              setStartPoint(value)
            }}
          />
        </div>

        <BranchField edit={branchEdit} derived={derived} planned={planned} problem={problem} onEdit={setBranchEdit} />

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
