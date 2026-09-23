// The window's end of unsaved files: it tells the main process which paths are edited (the close
// button's dot, `teamree quit`'s refusal) and answers its question before a quit or a close.

import { useEffect } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'

export function useUnsavedFiles(): void {
  useEffect(() => {
    // Absent without the preload (tests, a browser on the dev server).
    const bridge = window.teamree?.unsaved
    if (!bridge) return

    const stopAnswering = bridge.onAsk((reason) => useWorkspaceStore.getState().askBeforeLeaving(reason))

    let published: string | null = null
    const publish = (): void => {
      const paths = Object.values(useWorkspaceStore.getState().editedFiles).map((file) => file.path)
      const description = JSON.stringify(paths)
      if (description === published) return
      published = description
      bridge.publish(paths)
    }
    publish()
    const stopWatching = useWorkspaceStore.subscribe(publish)

    return () => {
      stopAnswering()
      stopWatching()
    }
  }, [])
}
