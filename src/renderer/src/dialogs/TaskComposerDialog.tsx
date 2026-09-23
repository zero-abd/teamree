// Starting work: describe the task, pick who does it, and where from.
//
// The unit of work is the task, not the checkout — so this is one action that
// creates the worktree and starts the agent in it, rather than a dialog that
// makes a directory and leaves the user to go and find an agent button. The
// description is the prominent field because it is the only one the user has to
// think about; everything else has a defensible default.
//
// Who does it is a count per agent rather than one name, because the workflow
// this app is for is several attempts at one description — two models against
// each other, or two runs of the same one, which is just as common a race.
//
// Submitting closes the dialog at once. Creation is a background job and its
// progress, including its failures, belongs on the sidebar row.

import { useEffect, useState } from 'react'
import { MAX_AGENT_ARGS_CHARS } from '@shared/agentLaunch'
import { useWorkspaceStore } from '../state/workspaceStore'
import { branchNameFromTask } from './branchNameFromTask'
import { Modal } from './Modal'
import { StartPointPicker, type StartPointValue } from './StartPointPicker'
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

  // What the box starts out saying, in order of who asked for it.
  //
  // A ref stored in settings for this project wins over the repository's base
  // ref, because it is the same person saying where their branches start and
  // they said it more recently. When the listing names that ref the option
  // behind it is attached too, so the picker shows its sha and its badges;
  // when it does not — a ref that has since been deleted, or one the runtime's
  // cap dropped — the text stands on its own, which `commitStartPoint` already
  // treats as a candidate in its own right.
  //
  // Otherwise the listing's base ref replaces the placeholder as it lands, as
  // it always has. Either way nothing overwrites what the user has already put
  // in the box; switching project clears `touched`, which is what lets the new
  // project's answer take over.
  //
  // The dependency list is `[startPoints, touched]` and must stay that way,
  // even though the body now also reads `projectId` and the stored refs. This
  // effect may only act on a listing, and the listing is the thing that arrives
  // late: adding `projectId` here makes it run the instant the project select
  // changes, while `startPoints` in this render's closure is still the previous
  // project's — which put the old repository's base ref back into a box the
  // select had just cleared. Both of the values read without being listed are
  // read on the render where the new listing lands, by which time they are the
  // new project's.
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

  // Null until the user steps something, so the preferred agent — or the first
  // one found, when there is no preference or it is not installed here — is
  // preselected without overwriting a choice made while the probe was still in
  // flight.
  const counts = agentCounts ?? defaultAgentCounts(agents, defaultAgent)
  const selection = fanOut(agents, counts)

  // Empty until there is something to slugify: the rule's fallback is the word
  // "worktree", and showing it before a key is pressed promises a branch name
  // that has nothing to do with the task about to be typed.
  const branchName = task.trim() ? branchNameFromTask(taskName(task)) : ''
  const startedFrom = startPoint.text.trim()
  // The text goes to the agent on one command line, so it is bounded where
  // that line is; a paste past the bound is refused here rather than cut.
  const tooLong = task.trim().length > MAX_AGENT_ARGS_CHARS
  const canSubmit = task.trim().length > 0 && !tooLong && startedFrom.length > 0

  const submit = (): void => {
    if (!canSubmit) return
    startTask({ projectId, startedFrom, creates: taskCreates(task, selection) })
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
            {tooLong ? (
              <>
                {task.trim().length} / {MAX_AGENT_ARGS_CHARS} chars ·{' '}
              </>
            ) : branchName ? (
              <>
                branch <code>{branchName}</code> ·{' '}
              </>
            ) : null}
            Shift+Enter for a new line
          </span>
        </label>

        {agents.length > 0 ? (
          <fieldset className="field agents">
            <legend className="field__label">Agents</legend>
            {agents.map((entry) => {
              const count = agentCount(counts, entry.kind)
              const step = (to: number): void => setAgentCounts(withAgentCount(counts, entry.kind, to))
              return (
                <div className="agents__row" key={entry.kind}>
                  <span className="agents__name" title={entry.binary}>
                    {entry.command}
                  </span>
                  <button
                    type="button"
                    className="agents__step"
                    aria-label={`One fewer ${entry.command}`}
                    disabled={count === 0}
                    onClick={() => step(count - 1)}
                  >
                    −
                  </button>
                  <output className="agents__count">{count}</output>
                  <button
                    type="button"
                    className="agents__step"
                    aria-label={`One more ${entry.command}`}
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
