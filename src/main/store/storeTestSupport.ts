// Tests open stores in temp folders. A store left open can save, back up or retry
// while the folder is being removed, and the removal fails with ENOTEMPTY.

import { rm } from 'node:fs/promises'
import { sep } from 'node:path'
import { WorkspaceStore, type WorkspaceStoreOptions } from './workspaceStore'

const openStores = new Set<WorkspaceStore>()

/** `WorkspaceStore.open`, closed by `removeTempDir` before its folder goes. */
export async function openTestStore(filePath: string, options?: WorkspaceStoreOptions): Promise<WorkspaceStore> {
  const store = await WorkspaceStore.open(filePath, options)
  openStores.add(store)
  return store
}

/** Closes every store opened under `dir`. */
export async function closeStoresIn(dir: string): Promise<void> {
  const inside = [...openStores].filter((store) => store.filePath.startsWith(dir + sep))
  for (const store of inside) openStores.delete(store)
  await Promise.all(inside.map((store) => store.close()))
}

/** Closes the stores under `dir`, then removes it. */
export async function removeTempDir(dir: string): Promise<void> {
  await closeStoresIn(dir)
  await rm(dir, { recursive: true, force: true })
}
