// Window-level key handling, in the capture phase so a chord is claimed before xterm's textarea; the
// terminals decline the same set via `isAppChord`. What a chord does is `workspaceCommands.ts`.
// On macOS the menu's key equivalents take most chords first; keys still land here on Windows/Linux
// and for disabled items, so the availability check must stay before `preventDefault`.

import { useCallback, useEffect } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { ModifierState, PlatformModifier } from './platformModifier'
import { isCommandAvailable, paneNumberTarget, runWorkspaceCommand } from './workspaceCommands'
import { commandForEvent, paneNumberForEvent } from './workspaceShortcuts'

export function useWorkspaceShortcuts(modifier: PlatformModifier): (event: KeyboardEvent) => boolean {
  const isAppChord = useCallback(
    (event: KeyboardEvent) => {
      const pressed = toModifierState(event)
      return commandForEvent(pressed, modifier) !== null || paneNumberForEvent(pressed, modifier) !== null
    },
    [modifier]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const pressed = toModifierState(event)
      const store = useWorkspaceStore.getState()

      const number = paneNumberForEvent(pressed, modifier)
      if (number !== null) {
        const target = paneNumberTarget(number, store)
        if (!target) return
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) store.showPane(target)
        return
      }

      const command = commandForEvent(pressed, modifier)
      if (!command) return

      // Refused: still an app chord (the terminals keep declining it) but nothing runs, which matters most
      // under the undismissable remote-keystrokes question.
      if (!isCommandAvailable(command, store)) return

      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return

      runWorkspaceCommand(command, store)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [modifier])

  return isAppChord
}

function toModifierState(event: KeyboardEvent): ModifierState & { key: string } {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey
  }
}
