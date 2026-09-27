// The projects header's +: the welcome's ways to a project, as a menu.

import { useRef, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { refocus, RowMenu, type MenuClosed, type RowMenuAnchor } from './RowMenu'
import { Icon } from '../icons/Icon'

export function AddProjectButton(): React.JSX.Element {
  const chooseProjectFolder = useWorkspaceStore((state) => state.chooseProjectFolder)
  const newProject = useWorkspaceStore((state) => state.newProject)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const button = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)

  const toggle = (): void => {
    if (menuAt !== null) {
      setMenuAt(null)
      return
    }
    const rect = button.current?.getBoundingClientRect()
    setMenuAt(rect === undefined ? { x: 0, y: 0 } : { x: rect.right, y: rect.bottom + 4, align: 'right' })
  }

  const close = (closed?: MenuClosed): void => {
    setMenuAt(null)
    refocus(button.current, closed)
  }

  return (
    <>
      <button
        type="button"
        className="button button--ghost button--icon"
        title="Add project"
        aria-label="Add project"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        ref={button}
        onClick={toggle}
      >
        <Icon name="plus" size={14} />
      </button>
      {menuAt === null ? null : (
        <RowMenu
          label="Add project"
          items={[
            { label: 'New Project…', onChoose: () => void newProject() },
            { label: 'Open Folder…', onChoose: () => void chooseProjectFolder() },
            { label: 'Clone Repository…', onChoose: () => openDialog({ kind: 'clone-project' }) },
            { label: 'Join a Team…', onChoose: () => openDialog({ kind: 'join-invitation' }) }
          ]}
          anchor={menuAt}
          onClose={close}
          opener={button.current}
        />
      )}
    </>
  )
}
