// The window's end of the menu bar: it publishes a finished description of its menus and runs what was
// chosen; main only draws it. Republished only when the description string changes, because
// `Menu.setApplicationMenu` closes an open menu on macOS.

import { useEffect } from 'react'
import { runWorkspaceCommand } from '../keyboard/workspaceCommands'
import { commandNamed } from '../keyboard/workspaceShortcuts'
import { useWorkspaceStore } from '../state/workspaceStore'
import { menuBarSpec } from './menuBar'

export function useMenuBar(): void {
  useEffect(() => {
    // Absent without the preload (tests, a browser on the dev server).
    const menu = window.teamree?.menu
    if (!menu) return

    // Checked against the table since it arrives over IPC. No auto-repeat guard: measured on the packaged
    // app, AppKit performs a key equivalent for the first key-down only.
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
