// The Open in submenu: the project's editor first, then the other editors, terminals and Finder
// found. A file goes to editors only; the main process never hands one to a terminal, which would run it.

import { useCallback } from 'react'
import type { ResultOf } from '@shared/methods'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { RowMenuItem } from './RowMenu'

type OpenTarget = ResultOf<'editor.list'>['editors'][number]
type Target = { command?: string; label: string; kind: 'editor' | 'terminal' | 'finder' }

/** The Open in rows for a path in a project; picking an editor makes it that project's. */
export function useOpenIn(): (projectId: string, path: string, what: string, file: boolean) => RowMenuItem[] {
  const editorCommands = useWorkspaceStore((state) => state.editorCommands)
  const editors = useWorkspaceStore((state) => state.editors)
  const setEditorCommand = useWorkspaceStore((state) => state.setEditorCommand)
  const openInEditor = useWorkspaceStore((state) => state.openInEditor)
  return useCallback(
    (projectId, path, what, file) => {
      const targets = openInTargets(editorCommands[projectId], editors)
      const offered = file ? targets.filter((target) => target.kind === 'editor') : targets
      return (offered.length > 0 ? offered : [EDITOR]).map((target) => ({
        label: target.label,
        onChoose: () => {
          if (target.kind === 'editor' && target.command !== undefined) setEditorCommand(projectId, target.command)
          void openInEditor(path, target.command, what)
        }
      }))
    },
    [editorCommands, editors, setEditorCommand, openInEditor]
  )
}

/** With nothing found, one entry that asks anyway, so the refusal reaches the screen. */
const EDITOR: Target = { label: 'Editor', kind: 'editor' }

/** The project's pick first, then everything found. */
function openInTargets(command: string | undefined, found: readonly OpenTarget[] | null): Target[] {
  const named = command?.trim() ?? ''
  const targets = (found ?? []).map((target) => ({ ...target, kind: target.kind ?? ('editor' as const) }))
  if (named.length > 0) {
    const picked = targets.find((target) => target.command === named) ?? {
      command: named,
      // A program typed into Settings, by its last path segment.
      label: named.split('/').filter(Boolean).pop() ?? named,
      kind: 'editor' as const
    }
    return [picked, ...targets.filter((target) => target !== picked)]
  }
  return targets.length > 0 ? targets : [EDITOR]
}
