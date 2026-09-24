// The projects header's +: a two-item menu, Open Folder… straight to the OS picker, or Clone….

import { useRef, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { RowMenu, type RowMenuAnchor } from './RowMenu'

export function AddProjectButton(): React.JSX.Element {
  const chooseProjectFolder = useWorkspaceStore((state) => state.chooseProjectFolder)
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

  const close = (): void => {
    setMenuAt(null)
    button.current?.focus()
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
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M7 2.5 L7 11.5 M2.5 7 L11.5 7" />
        </svg>
      </button>
      {menuAt === null ? null : (
        <RowMenu
          label="Add project"
          items={[
            { label: 'Open Folder…', onChoose: () => void chooseProjectFolder() },
            { label: 'Clone…', onChoose: () => openDialog({ kind: 'clone-project' }) }
          ]}
          anchor={menuAt}
          onClose={close}
          opener={button.current}
        />
      )}
    </>
  )
}
