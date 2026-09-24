// `.teamree/project.json`: a project's setup, committed so every teammate's
// worktrees get it. Read as input under this Mac's settings; written only when
// somebody presses Save to Repository, and never committed for them.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ProjectRepositorySettings } from '../../shared/entities'
import { MAX_SETUP_COMMAND_CHARS } from '../../shared/methods'
import { PROJECT_FILE, PROJECT_FILE_UNREADABLE, projectFileContents } from '../../shared/projectSettings'
import { normalizePreparedPaths } from '../git/worktreePreparation'

/** No file is `{}`; a file that cannot be used whole is a problem, never half its fields. */
export type ProjectFileRead = { settings?: ProjectRepositorySettings; problem?: string }

const PathList = z.array(z.string().min(1).max(512)).max(64)

const ProjectFileSchema = z.object({
  startFrom: z.string().trim().min(1).max(256).optional(),
  setupCommand: z.string().trim().min(1).max(MAX_SETUP_COMMAND_CHARS).optional(),
  linkedPaths: PathList.optional(),
  copiedPaths: PathList.optional()
})

export async function readProjectFile(root: string): Promise<ProjectFileRead> {
  let text: string
  try {
    text = await readFile(path.join(root, PROJECT_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { problem: PROJECT_FILE_UNREADABLE }
  }
  try {
    const parsed = ProjectFileSchema.parse(JSON.parse(text))
    const settings: ProjectRepositorySettings = {}
    if (parsed.startFrom !== undefined) settings.startFrom = parsed.startFrom
    if (parsed.setupCommand !== undefined) settings.setupCommand = parsed.setupCommand
    // The same judgement a path typed into Settings gets; one that leaves the repository spoils the file.
    if (parsed.linkedPaths !== undefined) settings.linkedPaths = normalizePreparedPaths(parsed.linkedPaths)
    if (parsed.copiedPaths !== undefined) settings.copiedPaths = normalizePreparedPaths(parsed.copiedPaths)
    return { settings }
  } catch {
    return { problem: PROJECT_FILE_UNREADABLE }
  }
}

/** Writes the file into the checkout at `root` and answers with its path relative to it. */
export async function writeProjectFile(root: string, settings: ProjectRepositorySettings): Promise<string> {
  const file = path.join(root, PROJECT_FILE)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, projectFileContents(settings))
  return PROJECT_FILE
}
