// Fetch Now: one project's base through the background fetcher, so its back-off is cleared too.

import { Params } from '../../../shared/methods'
import type { Project } from '../../../shared/entities'
import { ErrorCode } from '../../../shared/protocol'
import type { BaseFetcher } from '../../git/baseFetch'
import { GitServiceError } from '../../git/errors'
import type { GitService } from '../../git/gitService'
import type { MethodRegistry } from '../methodRegistry'

export async function fetchProjectNow(git: GitService, bases: BaseFetcher, projectId: string): Promise<Project> {
  const find = (): Project | undefined => git.listProjects().find((entry) => entry.id === projectId)
  const project = find()
  if (!project) throw new GitServiceError(ErrorCode.NotFound, `no project with id "${projectId}"`)
  await bases.fetchProject({ id: project.id, path: project.path, baseRef: project.baseRef })
  return find() ?? project
}

export function registerFetchHandler(registry: MethodRegistry, git: GitService, bases: BaseFetcher): void {
  registry.register('project.fetch', Params.projectFetch, ({ projectId }) => fetchProjectNow(git, bases, projectId))
}
