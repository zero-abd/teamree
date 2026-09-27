// Settings › Projects › Saved commands: one project's list (the repository's shown, not edited here),
// or with no project, the list every project offers. Reordered and deleted in place; added and edited in the sheet.

import type { Project, SavedCommand } from '@shared/entities'
import { savedCommandsOf, type SavedOffer } from '@shared/savedCommands'
import { useSavedCommandsStore } from '../state/savedCommandsStore'
import { useWorkspaceStore } from '../state/workspaceStore'
import { SAVED_COMMANDS_SETTING } from '../workspace/SavedCommands'

export function SavedCommandsSetting({ project }: { project?: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const everywhere = useSavedCommandsStore((state) => state.everywhere)
  const setEverywhere = useSavedCommandsStore((state) => state.setEverywhere)

  const offers: SavedOffer[] = project
    ? savedCommandsOf(project).filter((offer) => offer.source !== 'everywhere')
    : everywhere.map((command) => ({ command, source: 'everywhere', approved: true }))
  const own = project ? (project.savedCommands ?? []) : everywhere
  const write = (list: SavedCommand[]): void => {
    if (project) void setProjectPaths(project.id, { savedCommands: list })
    else void setEverywhere(list)
  }
  const move = (at: number, by: -1 | 1): void => {
    const list = [...own]
    const [taken] = list.splice(at, 1)
    if (taken === undefined) return
    list.splice(at + by, 0, taken)
    write(list)
  }
  const scope = project ? { projectId: project.id } : {}

  return (
    <div className="settings-field">
      <span className="settings-field__label">
        {project ? SAVED_COMMANDS_SETTING : `${SAVED_COMMANDS_SETTING} · all projects`}
      </span>
      <div className="saved-list">
        {offers.length === 0 ? null : (
          <ul className="saved-list__rows">
            {offers.map(({ command, source }, at) => (
              <li key={command.id} className="saved-list__row">
                <span className="saved-list__label">{command.label}</span>
                <code className="saved-list__text" title={command.text}>
                  {command.text}
                </code>
                {command.kind === 'agent' ? <span className="settings-chip">Agent</span> : null}
                {source === 'repository' ? (
                  <span className="settings-chip">Repository</span>
                ) : (
                  <span className="saved-list__actions">
                    <button
                      type="button"
                      className="button button--small"
                      aria-label={`Move ${command.label} up`}
                      title="Move up"
                      disabled={at === 0}
                      onClick={() => move(at, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="button button--small"
                      aria-label={`Move ${command.label} down`}
                      title="Move down"
                      disabled={at === own.length - 1}
                      onClick={() => move(at, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="button button--small"
                      aria-label={`Edit ${command.label}`}
                      onClick={() => openDialog({ kind: 'saved-command', ...scope, commandId: command.id })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button--small"
                      aria-label={`Delete ${command.label}`}
                      title="Delete"
                      onClick={() => write(own.filter((entry) => entry.id !== command.id))}
                    >
                      ×
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="button button--small saved-list__add"
          onClick={() => openDialog({ kind: 'saved-command', ...scope })}
        >
          Add
        </button>
      </div>
    </div>
  )
}
