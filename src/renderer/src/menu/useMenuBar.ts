// The window's end of the menu bar: it says what the menu should contain, and
// it runs what the menu says somebody chose.
//
// The menu bar lives in the main process because that is the only process that
// can install one, but everything it needs to be *honest* lives here — the
// command table, and the state that decides whether a command could do anything
// right now. So the window publishes a finished description of its own menus
// and the main process draws it. Nothing in main knows what a worktree is or
// which commands teamree has, and nothing here knows what an `NSMenu` is.
//
// Republished on every store change that changes the answer, and on no other.
// The comparison is a string compare of the description, which is the cheap
// half of a rebuild; the expensive half is `Menu.setApplicationMenu`, which
// replaces the bar and, on macOS, closes a menu the user has open. Almost every
// store change — a byte of pane output, a git status coming back — leaves all
// twelve answers exactly as they were, and those must not reach the main
// process at all. What does reach it is a pane opening or closing, a worktree
// becoming active, a modal going up: the handful of moments the menu genuinely
// has something different to say.

import { useEffect } from 'react'
import { runWorkspaceCommand } from '../keyboard/workspaceCommands'
import { commandNamed } from '../keyboard/workspaceShortcuts'
import { useWorkspaceStore } from '../state/workspaceStore'
import { menuBarSpec } from './menuBar'

export function useMenuBar(): void {
  useEffect(() => {
    // Absent in a test that renders the app without the preload, and in a
    // browser pointed at the dev server. Neither has a menu bar to fill.
    const menu = window.teamree?.menu
    if (!menu) return

    // What comes back is the `command` of an item this window itself published
    // a moment ago — but it is checked against the table anyway, because it
    // arrives over IPC and "it can only be one of ours" is the kind of thing
    // that stays true right up until it does not.
    //
    // No guard against key auto-repeat here, and that is measured rather than
    // assumed. The key handler drops `event.repeat`, and this path has no such
    // event to read — so the question was whether holding ⌘D would arrive here
    // once per repeat and split a pane each time. On the packaged app, with a
    // real held key (one key-down and eight auto-repeats), ⌘D split exactly
    // once and ⌘W closed exactly once: AppKit performs a key equivalent for
    // the first key-down and not for the repeats that follow it.
    const stopListening = menu.onCommand((value) => {
      const command = commandNamed(value)
      if (command) runWorkspaceCommand(command, useWorkspaceStore.getState())
    })

    let published: string | null = null
    const publish = (): void => {
      const spec = menuBarSpec(useWorkspaceStore.getState())
      const description = JSON.stringify(spec)
      if (description === published) return
      published = description
      menu.publish(spec)
    }

    publish()
    const stopWatching = useWorkspaceStore.subscribe(publish)

    return () => {
      stopListening()
      stopWatching()
    }
  }, [])
}
