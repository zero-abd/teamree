// Every project's saved commands, as the runtime's settings hold them, and the one question a
// repository's saved command gets before it first runs on this Mac.

import { create } from 'zustand'
import type { SavedCommand } from '@shared/entities'
import { savedCommandsOf } from '@shared/savedCommands'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { startSavedCommand } from '../workspace/savedCommandRun'
import { useWorkspaceStore } from './workspaceStore'

export type SavedAsk = { worktreeId: string; commandId: string; text: string }

type SavedCommandsState = {
  everywhere: readonly SavedCommand[]
  ask: SavedAsk | null
  load: () => Promise<void>
  /** Replaces every project's list; what the runtime answers is what stays. */
  setEverywhere: (list: readonly SavedCommand[]) => Promise<void>
  /** Runs a saved command in the worktree; a repository's this Mac has not approved asks first. */
  run: (worktreeId: string, commandId: string) => Promise<void>
  /** Run approves the asked command for its project and runs it; Skip only drops the question. */
  answer: (run: boolean) => Promise<void>
}

export const useSavedCommandsStore = create<SavedCommandsState>((set, get) => {
  const offer = (worktreeId: string, commandId: string) => {
    const { worktrees, projects } = useWorkspaceStore.getState()
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    const project = projects.find((entry) => entry.id === worktree?.projectId)
    const found = savedCommandsOf(project, get().everywhere).find((entry) => entry.command.id === commandId)
    return found === undefined || project === undefined ? undefined : { ...found, project }
  }

  return {
    everywhere: [],
    ask: null,

    async load() {
      const settings = await runtimeClient.call('settings.get', {}).catch(() => null)
      if (settings !== null) set({ everywhere: settings.savedCommands ?? [] })
    },

    async setEverywhere(list) {
      try {
        const settings = await runtimeClient.call('settings.set', { savedCommands: [...list] })
        set({ everywhere: settings.savedCommands ?? [] })
      } catch (error) {
        useWorkspaceStore.getState().showNotice(`Could not save: ${String(error)}`, 'error')
      }
    },

    async run(worktreeId, commandId) {
      const found = offer(worktreeId, commandId)
      if (found === undefined) return
      if (!found.approved) {
        set({ ask: { worktreeId, commandId, text: found.command.text } })
        return
      }
      await startSavedCommand(worktreeId, found.command)
    },

    async answer(run) {
      const ask = get().ask
      set({ ask: null })
      if (ask === null || !run) return
      const found = offer(ask.worktreeId, ask.commandId)
      if (found === undefined || found.command.text !== ask.text) return
      await useWorkspaceStore.getState().setProjectPaths(found.project.id, { approveCommand: ask.text })
      // A refused approval has already said so; nothing runs unapproved.
      if (offer(ask.worktreeId, ask.commandId)?.approved === true)
        await startSavedCommand(ask.worktreeId, found.command)
    }
  }
})
