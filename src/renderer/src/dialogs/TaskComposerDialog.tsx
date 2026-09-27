// Starting work: describe the task, pick who does it (a count per agent, for racing attempts), and
// where from, or under which worktree. One action makes the worktree and starts the agents; progress lives on the sidebar row.

import { useEffect, useState } from 'react'
import { MAX_AGENT_ARGS_CHARS } from '@shared/agentLaunch'
import { branchPrefixFor } from '@shared/branchName'
import type { WorktreeIssue } from '@shared/entities'
import { permissionModesFor } from '@shared/permissionMode'
import { formatChord, windowModifier } from '../keyboard/platformModifier'
import { useRuntimeSettings } from '../settings/runtimeSettings'
import { startPointAge } from '../sidebar/baseFreshness'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { AgentSteppers } from './AgentSteppers'
import { BranchField } from './BranchField'
import { branchNameFromTask } from './branchNameFromTask'
import { IssuePicker } from './IssuePicker'
import { issueBranch, issueTask } from './issueModel'
import { Modal } from './Modal'
import { Select } from '../ui/Select'
import { StartPointPicker, type StartPointValue } from './StartPointPicker'
import { landedAhead } from './startPointModel'
import {
  branchProblem,
  defaultAgentCounts,
  fanOut,
  plannedBranches,
  taskCreates,
  taskName,
  taskPlanNote,
  type AgentCounts,
  type AgentModes
} from './taskPlan'
import { useStartPoints } from './useStartPoints'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'

export function TaskComposerDialog({
  projectId: openedFor,
  parentId,
  fromIssue = false,
  task: initialTask = ''
}: {
  projectId: string
  /** A child task of this worktree: it starts from its branch. */
  parentId?: string
  /** Opens on the issue picker. */
  fromIssue?: boolean
  task?: string
}): React.JSX.Element | null {
  const projects = useWorkspaceStore((state) => state.projects)
  const agents = useWorkspaceStore((state) => state.agents)
  const agentsProbed = useWorkspaceStore((state) => state.agentsProbed)
  const startTask = useWorkspaceStore((state) => state.startTask)
  const startPointDefaults = useWorkspaceStore((state) => state.startPointDefaults)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const permissionModes = useWorkspaceStore((state) => state.permissionModes)
  const rememberPermissionModes = useWorkspaceStore((state) => state.rememberPermissionModes)
  const parent = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === parentId))
  const parentStatus = useWorkspaceStore((state) => (parentId === undefined ? undefined : state.statuses[parentId]))
  const fetching = useWorkspaceStore((state) => state.fetching)
  const fetchProject = useWorkspaceStore((state) => state.fetchProject)
  const now = useNow(60_000)

  const [projectId, setProjectId] = useState(openedFor)
  const [task, setTask] = useState(initialTask)
  const [agentCounts, setAgentCounts] = useState<AgentCounts | null>(null)
  // Picked in this dialog; the rest follow what the project last started with.
  const [modeEdits, setModeEdits] = useState<AgentModes>({})
  const [startPoint, setStartPoint] = useState<StartPointValue>({ text: '', option: null })
  const [touched, setTouched] = useState(false)
  // A branch typed by hand, kept while the task is edited; null follows the task.
  const [branchEdit, setBranchEdit] = useState<string | null>(null)
  const [picking, setPicking] = useState(fromIssue)
  // Whether the picker has been open, so the task box it gives way to takes the cursor back.
  const [pickedOnce, setPickedOnce] = useState(fromIssue)
  const [issue, setIssue] = useState<WorktreeIssue | null>(null)
  const machine = useRuntimeSettings().settings

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
    // Landed and not pushed yet: the base would start the task without it.
    const base = landedAhead(startPoints.list) ?? startPoints.list.options.find((option) => option.isBase) ?? null
    setStartPoint({ text: base?.ref ?? startPoints.list.baseRef, option: base })
  }, [startPoints, touched])

  if (!project) return null

  // Null until the user steps something, so the preselection never overwrites an early choice.
  const counts = agentCounts ?? defaultAgentCounts(agents, defaultAgent)
  const selection = fanOut(agents, counts)
  const modes: AgentModes = { ...permissionModes[projectId], ...modeEdits }

  // Taken names: local branches the listing carries, and branches of worktrees the app already has.
  const existing = [
    ...(startPoints.phase === 'ready' ? startPoints.list.options : [])
      .filter((option) => option.kind === 'localBranch')
      .map((option) => option.refName ?? option.ref),
    ...worktrees.filter((worktree) => worktree.projectId === projectId).map((worktree) => worktree.branch)
  ]
  const hasTask = task.trim().length > 0
  const prefix = branchPrefixFor(project, machine?.branchPrefix)
  const creates = taskCreates(task, selection, branchEdit?.trim() ?? '', modes)
  const planned = hasTask ? plannedBranches(creates, existing, prefix) : []
  // One run shows its exact branch, suffix included; several show the stem their names share.
  const derived = !hasTask
    ? ''
    : creates.length > 1
      ? `${prefix}${branchNameFromTask(taskName(task))}`
      : (plannedBranches(taskCreates(task, selection), existing, prefix)[0] ?? '')
  const problem = branchProblem(creates, existing)
  const startedFrom = parent?.branch ?? startPoint.text.trim()
  // Only the base is fetched in the background, so only it can be said to be old.
  const age = startedFrom === project.baseRef ? startPointAge(project, now) : null
  const leftBehind =
    parentStatus === undefined ? 0 : parentStatus.staged + parentStatus.unstaged + parentStatus.untracked
  // Bounded by the agent's command line; a paste past it is refused, not cut.
  const tooLong = task.trim().length > MAX_AGENT_ARGS_CHARS
  const canSubmit = hasTask && !tooLong && startedFrom.length > 0 && problem === null

  const submit = (): void => {
    if (!canSubmit) return
    const used = Object.fromEntries(
      selection
        .filter((agent) => permissionModesFor(agent.kind).length > 0)
        .map((agent) => [agent.kind, modes[agent.kind] ?? 'default'])
    )
    rememberPermissionModes(projectId, used)
    startTask({
      projectId,
      startedFrom,
      ...(parent === undefined ? {} : { parentId: parent.id }),
      ...(issue === null ? {} : { issue }),
      creates
    })
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
        {parent === undefined ? null : (
          <p className="form__under">
            <span className="form__under-name">{`Under ${worktreeDisplay(parent).title}`}</span>
            <span className="form__under-from">{`from ${parent.branch}`}</span>
            {leftBehind > 0 ? (
              <span className="form__under-left">{`${leftBehind} uncommitted not included`}</span>
            ) : null}
          </p>
        )}

        {picking ? (
          <IssuePicker
            projectId={projectId}
            onPick={(picked) => {
              setTask(issueTask(picked))
              // A child's branch is named from its parent's; the issue names only a new one.
              if (parent === undefined) setBranchEdit(`${prefix}${issueBranch(picked)}`)
              setIssue({ number: picked.number, url: picked.url })
              setPicking(false)
            }}
            onClose={() => setPicking(false)}
          />
        ) : (
          <div className="task-field">
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
                // Back from the picker, the task is what is left to edit.
                autoFocus={pickedOnce}
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
            {/* After the box in the DOM, so the dialog still opens with the cursor in the task. */}
            <div className="task-source">
              {issue === null ? null : (
                <span className="chip task-source__issue">
                  <a href={issue.url} target="_blank" rel="noreferrer">{`#${issue.number}`}</a>
                  <button
                    type="button"
                    className="task-source__unlink"
                    aria-label={`Unlink #${issue.number}`}
                    onClick={() => setIssue(null)}
                  >
                    ×
                  </button>
                </span>
              )}
              <button
                type="button"
                className="button button--ghost button--tiny"
                onClick={() => {
                  setPickedOnce(true)
                  setPicking(true)
                }}
              >
                From Issue…
              </button>
            </div>
          </div>
        )}

        <AgentSteppers
          agents={agents}
          counts={counts}
          onChange={setAgentCounts}
          modes={modes}
          onMode={(kind, mode) => setModeEdits({ ...modeEdits, [kind]: mode })}
        />

        {parent === undefined ? (
          <>
            <div className="form__where">
              <label className="field">
                <span className="field__label">Project</span>
                <Select
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value)
                    // An issue of the old project's repository.
                    setIssue(null)
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
                note={
                  age === null ? null : (
                    <>
                      {` · ${age} `}
                      <button
                        type="button"
                        className="button button--ghost button--tiny"
                        disabled={fetching[projectId] === true}
                        onClick={() => void fetchProject(projectId).then(reload)}
                      >
                        {fetching[projectId] ? 'Fetching…' : 'Fetch Now'}
                      </button>
                    </>
                  )
                }
              />
            </div>

            <BranchField
              edit={branchEdit}
              derived={derived}
              planned={planned}
              problem={problem}
              onEdit={setBranchEdit}
            />
          </>
        ) : null}

        <footer className="modal__actions">
          <p className="form__note">{taskPlanNote(agents, agentsProbed, selection)}</p>
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          {/* Filled while it cannot go yet, so the dialog always shows its one primary; `submit` refuses. */}
          <button type="submit" className="button button--primary" aria-disabled={!canSubmit}>
            Start Task
            <kbd className="button__kbd" aria-hidden="true">
              {formatChord({ key: 'Enter' }, windowModifier())}
            </kbd>
          </button>
        </footer>
      </form>
    </Modal>
  )
}
