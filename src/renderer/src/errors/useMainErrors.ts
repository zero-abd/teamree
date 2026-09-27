// A main-process error the app survived, as one line in the corner; the main process sends at most one a minute.

import { useEffect } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'

export function useMainErrors(): void {
  useEffect(
    () =>
      window.teamree?.errors?.onMainError((details) =>
        useWorkspaceStore.getState().showNotice('Something went wrong', 'error', {
          label: 'Copy Details',
          copy: details
        })
      ),
    []
  )
}
