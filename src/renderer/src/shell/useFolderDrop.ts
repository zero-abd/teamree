// Folders dropped from the file manager anywhere on the window are added as
// projects; one that cannot be opens Add project with the refusal.

import { useEffect } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'

export function useFolderDrop(): void {
  useEffect(() => {
    const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false
    const onDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event) || !event.dataTransfer) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event) || !event.dataTransfer) return
      event.preventDefault()
      // Read now: the transfer is emptied once this handler returns.
      void addFolders(droppedFolders(event.dataTransfer))
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
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
      openDialog({ kind: 'add-project', folder, refusal })
      return
    }
  }
}
