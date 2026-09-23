// Window-level key handling. The listener runs in the capture phase so a chord
// is claimed before xterm's textarea sees it, and `isAppChord` is handed to the
// terminals so they decline the same set.
//
// What a chord *does* is not here any more — it is in `workspaceCommands.ts`,
// which the menu bar reads too. This file is only about the key: which event is
// a chord, whether the window claims it, and handing the command on.
//
// **On macOS most of these keys never arrive here at all**, and that is the
// design rather than an accident. Every one of these commands is also a menu
// item carrying the same chord as its key equivalent, and AppKit performs a key
// equivalent before the event reaches the window's web contents — so ⌘D goes to
// the menu, the menu tells the renderer, and this listener never sees it.
// Exactly one layer acts on one keypress, which is the whole point: a menu
// accelerator and a key handler both firing would split two panes on one press.
//
// This listener is still what runs when the menu does not take the key:
//
//   - On Windows and Linux, where the teamree items ask not to register their
//     accelerators at all (`registerAccelerator: false`) and only display them.
//   - On macOS whenever the item is **disabled**, because a disabled item does
//     not perform its key equivalent and the event carries on down the
//     responder chain to the page. It lands here, and `isCommandAvailable` —
//     the same predicate that greyed the item out — declines it. So the key
//     does nothing, which is what the grey said it would do.
//
// That is why the availability check below is not an optimisation and must not
// move after `preventDefault`: on macOS it is the second half of the menu's own
// enablement, standing where the fallen-through key arrives.

import { useCallback, useEffect } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { ModifierState, PlatformModifier } from './platformModifier'
import { isCommandAvailable, runWorkspaceCommand } from './workspaceCommands'
import { commandForEvent } from './workspaceShortcuts'

export function useWorkspaceShortcuts(modifier: PlatformModifier): (event: KeyboardEvent) => boolean {
  const isAppChord = useCallback(
    (event: KeyboardEvent) => commandForEvent(toModifierState(event), modifier) !== null,
    [modifier]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = commandForEvent(toModifierState(event), modifier)
      if (!command) return

      const store = useWorkspaceStore.getState()
      // Refused, so not acted on. The chord is still an app chord — `isAppChord`
      // above says so without asking whether it is available, so the terminals
      // keep declining it and nothing reaches a pty — but nothing runs, which
      // matters most for the modals `isCommandAvailable` refuses under: a chord
      // that fired behind the question about a teammate's keystrokes acted on a
      // window the owner cannot see and, because that prompt will not dismiss,
      // cannot get back to.
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
