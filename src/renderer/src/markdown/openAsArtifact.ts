// `Open as artifact` from a page's menu: the page as it stands, unwritten edits included, copied,
// then a new chat opened to paste it into.

import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore } from '../state/workspaceStore'
import { NEW_CHAT_URL } from './artifactUrl'

const pages = new Map<string, () => string>()

/** Lets the menu read the page a pane shows; the returned function forgets it. */
export function registerPage(paneId: string, read: () => string): () => void {
  pages.set(paneId, read)
  return () => {
    if (pages.get(paneId) === read) pages.delete(paneId)
  }
}

export async function openAsArtifact(paneId: string, name: string): Promise<void> {
  const read = pages.get(paneId)
  if (read === undefined) return
  await useWorkspaceStore.getState().copyToClipboard(read(), name)
  openInBrowser(NEW_CHAT_URL)
}
