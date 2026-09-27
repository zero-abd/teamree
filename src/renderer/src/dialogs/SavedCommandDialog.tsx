// Adds or edits one saved command or prompt: its label, its text, where it goes, and whether this
// project or every project offers it. Changing that last moves it between the two lists.

import { useId, useState } from 'react'
import type { AgentKind, SavedCommand } from '@shared/entities'
import { harnessName } from '../agents/harnesses'
import { useSavedCommandsStore } from '../state/savedCommandsStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'
import { Select } from './Select'

type Scope = 'project' | 'everywhere'

const WHERE: Record<SavedCommand['kind'], readonly { value: SavedCommand['where']; label: string }[]> = {
  shell: [
    { value: 'new', label: 'New pane' },
    { value: 'current', label: 'Current pane' }
  ],
  agent: [
    { value: 'current', label: 'Running agent' },
    { value: 'new', label: 'New agent' },
    { value: 'task', label: 'New task' }
  ]
}

export function SavedCommandDialog({
  projectId,
  commandId
}: {
  projectId?: string
  commandId?: string
}): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const agents = useWorkspaceStore((state) => state.agents)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  const everywhere = useSavedCommandsStore((state) => state.everywhere)
  const setEverywhere = useSavedCommandsStore((state) => state.setEverywhere)
  const id = useId()

  const own = project?.savedCommands ?? []
  const origin: Scope | undefined = own.some((command) => command.id === commandId)
    ? 'project'
    : everywhere.some((command) => command.id === commandId)
      ? 'everywhere'
      : undefined
  const editing = [...own, ...everywhere].find((command) => command.id === commandId)

  const [label, setLabel] = useState(editing?.label ?? '')
  const [text, setText] = useState(editing?.text ?? '')
  const [kind, setKind] = useState<SavedCommand['kind']>(editing?.kind ?? 'shell')
  const [where, setWhere] = useState<SavedCommand['where']>(editing?.where ?? 'new')
  const [agent, setAgent] = useState<AgentKind | ''>(editing?.agent ?? '')
  const [scope, setScope] = useState<Scope>(origin ?? (project ? 'project' : 'everywhere'))
  const canSave = label.trim() !== '' && text.trim() !== ''

  const changeKind = (next: SavedCommand['kind']): void => {
    setKind(next)
    if (!WHERE[next].some((option) => option.value === where)) setWhere(next === 'shell' ? 'new' : 'current')
  }

  const write = async (list: Scope, commands: SavedCommand[]): Promise<void> => {
    if (list === 'everywhere') await setEverywhere(commands)
    else if (project) await setProjectPaths(project.id, { savedCommands: commands })
  }

  const without = (list: readonly SavedCommand[]): SavedCommand[] => list.filter((entry) => entry.id !== commandId)

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSave) return
    const command: SavedCommand = {
      id: editing?.id ?? newId(),
      label: label.trim(),
      text: text.trim(),
      kind,
      where,
      ...(kind === 'agent' && where === 'new' && agent !== '' ? { agent } : {})
    }
    const target = scope === 'project' ? own : everywhere
    const placed = target.some((entry) => entry.id === command.id)
      ? target.map((entry) => (entry.id === command.id ? command : entry))
      : [...target, command]
    closeDialog()
    if (origin !== undefined && origin !== scope) await write(origin, without(origin === 'project' ? own : everywhere))
    await write(scope, placed)
  }

  const remove = async (): Promise<void> => {
    closeDialog()
    if (origin !== undefined) await write(origin, without(origin === 'project' ? own : everywhere))
  }

  return (
    <Modal title={editing ? 'Edit Command' : 'New Command'} onClose={closeDialog}>
      <form className="form saved-command" onSubmit={(event) => void save(event)}>
        <div className="saved-command__row">
          <div className="field saved-command__label">
            <label className="field__label" htmlFor={`${id}-label`}>
              Label
            </label>
            <input
              id={`${id}-label`}
              className="field__input"
              value={label}
              placeholder="Lint"
              autoComplete="off"
              autoFocus
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-kind`}>
              Kind
            </label>
            <Select
              id={`${id}-kind`}
              value={kind}
              onChange={(event) => changeKind(event.target.value as SavedCommand['kind'])}
            >
              <option value="shell">Terminal</option>
              <option value="agent">Agent</option>
            </Select>
          </div>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-text`}>
            {kind === 'shell' ? 'Command' : 'Prompt'}
          </label>
          <textarea
            id={`${id}-text`}
            className={`field__input field__input--message${kind === 'shell' ? ' field__input--mono' : ''}`}
            rows={kind === 'shell' ? 1 : 3}
            value={text}
            placeholder={kind === 'shell' ? 'npm run lint' : 'Review the diff'}
            spellCheck={kind === 'agent'}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="saved-command__row">
          <div className="field">
            <label className="field__label" htmlFor={`${id}-where`}>
              Where
            </label>
            <Select
              id={`${id}-where`}
              value={where}
              onChange={(event) => setWhere(event.target.value as SavedCommand['where'])}
            >
              {WHERE[kind].map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          {kind === 'agent' && where === 'new' ? (
            <div className="field">
              <label className="field__label" htmlFor={`${id}-agent`}>
                Agent
              </label>
              <Select id={`${id}-agent`} value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>
                <option value="">Default</option>
                {agents.map((installed) => (
                  <option key={installed.kind} value={installed.kind}>
                    {harnessName(installed.kind)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {project ? (
            <div className="field">
              <label className="field__label" htmlFor={`${id}-scope`}>
                For
              </label>
              <Select id={`${id}-scope`} value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
                <option value="project">{project.name}</option>
                <option value="everywhere">All projects</option>
              </Select>
            </div>
          ) : null}
        </div>
        <footer className="modal__actions">
          {origin === undefined ? null : (
            <button type="button" className="button button--danger saved-command__delete" onClick={() => void remove()}>
              Delete
            </button>
          )}
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!canSave}>
            Save
          </button>
        </footer>
      </form>
    </Modal>
  )
}

function newId(): string {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
