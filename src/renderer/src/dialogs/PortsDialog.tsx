// Show Ports: every port the panes listen on, across worktrees, with Open, Copy URL and Stop.

import { copyText } from '../clipboard/clipboard'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { openInBrowser } from '../shell/openInBrowser'
import { listPorts, portClashes, portUrl, type PortEntry } from '../sidebar/portChip'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Modal } from './Modal'

export function PortsDialog(): React.JSX.Element {
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const all = Object.values(terminals)
  const entries = listPorts(all)
  const clashes = portClashes(all)
  const nameOf = (worktreeId: string): string => worktrees.find((entry) => entry.id === worktreeId)?.name ?? worktreeId

  const stop = (entry: PortEntry): void => {
    void runtimeClient.call('system.kill', { pid: entry.pid }).catch(() => undefined)
  }

  return (
    <Modal title="Ports" onClose={closeDialog}>
      <div className="ports">
        {[...clashes].map(([port, holders]) => (
          <p className="ports__clash" key={port}>
            {`:${port} in ${holders.map(nameOf).join(' and ')}`}
          </p>
        ))}
        {entries.length === 0 ? (
          <p className="ports__empty">No ports</p>
        ) : (
          <ul className="ports__list">
            {entries.map((entry) => (
              <li className="ports__row" key={`${entry.terminalId}:${entry.pid}:${entry.port}`}>
                <span className={`ports__port${clashes.has(entry.port) ? ' ports__port--clash' : ''}`}>
                  {`:${entry.port}`}
                </span>
                <span className="ports__command">{entry.command}</span>
                <span className="ports__worktree">{nameOf(entry.worktreeId)}</span>
                <button
                  type="button"
                  className="button button--ghost button--tiny"
                  onClick={() => openInBrowser(portUrl(entry.port))}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="button button--ghost button--tiny"
                  onClick={() => copyText(portUrl(entry.port))}
                >
                  Copy URL
                </button>
                <button type="button" className="button button--ghost button--tiny" onClick={() => stop(entry)}>
                  Stop
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
