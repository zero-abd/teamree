// A project's setup as it applies on this Mac: the value set here, else the one
// `.teamree/project.json` carries, else nothing. Local always wins.

import type { Project, ProjectRepositorySettings } from './entities'

/** Where the shared setup lives, relative to the primary checkout. */
export const PROJECT_FILE = '.teamree/project.json'

/** The line Settings shows when the file is there and cannot be used. */
export const PROJECT_FILE_UNREADABLE = 'project.json unreadable'

/** The three settings both places can hold; the start point is the renderer's and has its own helper. */
export type ProjectSettingField = 'linkedPaths' | 'copiedPaths' | 'setupCommand'

export type EffectiveProjectSettings = Pick<Project, ProjectSettingField>

export function effectiveProjectSettings(project: Project): EffectiveProjectSettings {
  const repository = project.repository ?? {}
  const settings: EffectiveProjectSettings = {}
  for (const field of ['linkedPaths', 'copiedPaths'] as const) {
    const value = project[field] ?? repository[field]
    if (value !== undefined) settings[field] = value
  }
  const command = project.setupCommand ?? repository.setupCommand
  if (command !== undefined) settings.setupCommand = command
  return settings
}

/**
 * Where a setting's value comes from: `local` only when it overrides a different
 * repository value, since a value the file does not carry is simply this Mac's.
 */
export function settingSource(
  local: string | readonly string[] | undefined,
  repository: string | readonly string[] | undefined
): 'repository' | 'local' | null {
  if (repository === undefined) return null
  if (local === undefined || String(local) === String(repository)) return 'repository'
  return 'local'
}

/** The ref new worktrees start from: this Mac's choice, else the repository's, else the base ref. */
export function startPointOf(project: Project, stored: string | undefined): string {
  return stored || project.repository?.startFrom || project.baseRef
}

/** The file's contents for these values, fields in a fixed order and empty ones left out. */
export function projectFileContents(settings: ProjectRepositorySettings): string {
  const ordered: ProjectRepositorySettings = {}
  if (settings.startFrom) ordered.startFrom = settings.startFrom
  if (settings.setupCommand) ordered.setupCommand = settings.setupCommand
  if (settings.linkedPaths?.length) ordered.linkedPaths = settings.linkedPaths
  if (settings.copiedPaths?.length) ordered.copiedPaths = settings.copiedPaths
  return `${JSON.stringify(ordered, null, 2)}\n`
}
