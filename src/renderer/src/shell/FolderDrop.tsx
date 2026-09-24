// Folders dropped from the file manager anywhere on the window are added as
// projects; one that cannot be opens its refusal.

import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'

/** Listens on the whole window, and covers it while a folder is dragged over. */
export function FolderDrop(): React.JSX.Element | null {
  const over = useFolderDrop()
  return over ? (
    <div className="folder-drop" aria-hidden="true">
      <span className="folder-drop__label">Add project</span>
    </div>
  ) : null
}

/** How long a drag may send no over before the overlay comes down; the next over puts it back. */
const QUIET_MS = 1500

function useFolderDrop(): boolean {
  const [over, setOver] = useState(false)

  useEffect(() => {
    // Every element entered and left fires on the way; the count reaches zero only off the window.
    let depth = 0
    // A drag cancelled off the window may send no leave at all.
    let quiet: ReturnType<typeof setTimeout> | undefined
    const hide = (): void => {
      clearTimeout(quiet)
      depth = 0
      setOver(false)
    }
    const show = (): void => {
      clearTimeout(quiet)
      quiet = setTimeout(hide, QUIET_MS)
      setOver(true)
    }
    const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false
    const onDragEnter = (event: DragEvent): void => {
      if (!event.dataTransfer || !carriesFolder(event.dataTransfer)) return
      depth += 1
      show()
    }
    // Not read for what it carries: only an enter that was counted can be left.
    const onDragLeave = (): void => {
      if (depth === 0) return
      depth -= 1
      if (depth === 0) hide()
    }
    const onDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event) || !event.dataTransfer) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      if (carriesFolder(event.dataTransfer)) show()
    }
    const onDrop = (event: DragEvent): void => {
      hide()
      if (!carriesFiles(event) || !event.dataTransfer) return
      event.preventDefault()
      // Read now: the transfer is emptied once this handler returns.
      void addFolders(droppedFolders(event.dataTransfer))
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      clearTimeout(quiet)
    }
  }, [])

  return over
}

/** Before the drop only kind and type are readable, and a folder is a file with no type. */
function carriesFolder(transfer: DataTransfer): boolean {
  return Array.from(transfer.items ?? []).some((item) => item.kind === 'file' && item.type === '')
}

function droppedFolders(transfer: DataTransfer): string[] {
  const pathFor = window.teamree?.pathForFile
  if (!pathFor) return []
  const folders: string[] = []
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file' || !item.webkitGetAsEntry()?.isDirectory) continue
    const file = item.getAsFile()
    const path = file ? pathFor(file) : ''
    if (path) folders.push(path)
  }
  return folders
}

async function addFolders(folders: string[]): Promise<void> {
  const { addProject, openDialog } = useWorkspaceStore.getState()
  for (const folder of folders) {
    const refusal = await addProject(folder)
    if (refusal) {
      openDialog({ kind: 'project-refused', folder, refusal })
      return
    }
  }
}
