// Saved commands and prompts as a worktree offers them: this project's, then the repository's (each
// text asked about once, as a run command is), then every project's.

import type { Project, SavedCommand } from './entities'

/** The most one list keeps. */
export const MAX_SAVED_COMMANDS = 64

export type SavedCommandSource = 'project' | 'repository' | 'everywhere'

export type SavedOffer = { command: SavedCommand; source: SavedCommandSource; approved: boolean }

export function savedCommandsOf(project: Project | undefined, everywhere: readonly SavedCommand[] = []): SavedOffer[] {
  const own = project?.savedCommands ?? []
  const ids = new Set(own.map((command) => command.id))
  const texts = new Set(own.map((command) => command.text))
  const approved = new Set(project?.approvedSavedCommands ?? [])
  const repository = (project?.repository?.savedCommands ?? []).filter(
    (command) => !ids.has(command.id) && !texts.has(command.text)
  )
  return [
    ...own.map((command): SavedOffer => ({ command, source: 'project', approved: true })),
    ...repository.map(
      (command): SavedOffer => ({ command, source: 'repository', approved: approved.has(command.text) })
    ),
    ...everywhere
      .filter((command) => !ids.has(command.id))
      .map((command): SavedOffer => ({ command, source: 'everywhere', approved: true }))
  ]
}

/** This Mac's list with the repository's after it, one per id: what Save to Repository writes. */
export function projectSavedCommands(project: Project): SavedCommand[] | undefined {
  const own = project.savedCommands ?? []
  const ids = new Set(own.map((command) => command.id))
  const merged = [...own, ...(project.repository?.savedCommands ?? []).filter((command) => !ids.has(command.id))]
  return merged.length === 0 ? undefined : merged
}
