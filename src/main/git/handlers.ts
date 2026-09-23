// The git surface the runtime wires up. Everything a handler throws is a
// GitServiceError, so the dispatcher preserves its ErrorCode. `git.events`,
// `cancelWorktreeCreate`, `describeStartPoint` and `startPointFor` have no method and are reached on the service.

import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { GitService } from './gitService'

export const GIT_METHODS = [
  'project.list',
  'project.add',
  'project.remove',
  'project.setPaths',
  'worktree.list',
  'worktree.get',
  'worktree.create',
  'worktree.remove',
  'worktree.rename',
  'worktree.status',
  'worktree.changes',
  'worktree.diff',
  'worktree.files',
  'worktree.findFiles',
  'worktree.commit',
  'worktree.stageHunk',
  'worktree.unstageHunk',
  'worktree.log',
  'worktree.mergePreview',
  'worktree.push',
  'worktree.startPoints'
] as const

export type GitMethodName = (typeof GIT_METHODS)[number]

export type GitHandlers = {
  [M in GitMethodName]: (params: ParamsOf<M>) => Promise<ResultOf<M>>
}

export function createGitHandlers(service: GitService): GitHandlers {
  return {
    'project.list': async () => service.listProjects(),
    'project.add': (params) => service.addProject(params),
    'project.remove': (params) => service.removeProject(params),
    'project.setPaths': (params) => service.setProjectPaths(params),
    'worktree.list': (params) => service.listWorktrees(params),
    'worktree.get': (params) => service.getWorktree(params),
    'worktree.create': (params) => service.createWorktree(params),
    'worktree.remove': (params) => service.removeWorktree(params),
    'worktree.rename': (params) => service.renameWorktree(params),
    'worktree.status': (params) => service.worktreeStatus(params),
    'worktree.changes': (params) => service.worktreeChanges(params),
    'worktree.diff': (params) => service.worktreeDiff(params),
    'worktree.files': (params) => service.worktreeFiles(params),
    'worktree.findFiles': (params) => service.worktreeFindFiles(params),
    'worktree.commit': (params) => service.worktreeCommit(params),
    'worktree.stageHunk': (params) => service.worktreeStageHunk(params),
    'worktree.unstageHunk': (params) => service.worktreeUnstageHunk(params),
    'worktree.log': (params) => service.worktreeLog(params),
    'worktree.mergePreview': (params) => service.worktreeMergePreview(params),
    'worktree.push': (params) => service.worktreePush(params),
    'worktree.startPoints': (params) =>
      service.listStartPoints(params.projectId, params.limit === undefined ? {} : { limit: params.limit })
  }
}

export function registerGitHandlers(registry: MethodRegistry, service: GitService): GitService {
  const handlers = createGitHandlers(service)
  registry.register('project.list', Params.projectList, handlers['project.list'])
  registry.register('project.add', Params.projectAdd, handlers['project.add'])
  registry.register('project.remove', Params.projectRemove, handlers['project.remove'])
  registry.register('project.setPaths', Params.projectSetPaths, handlers['project.setPaths'])
  registry.register('worktree.list', Params.worktreeList, handlers['worktree.list'])
  registry.register('worktree.get', Params.worktreeGet, handlers['worktree.get'])
  registry.register('worktree.create', Params.worktreeCreate, handlers['worktree.create'])
  registry.register('worktree.remove', Params.worktreeRemove, handlers['worktree.remove'])
  registry.register('worktree.rename', Params.worktreeRename, handlers['worktree.rename'])
  registry.register('worktree.status', Params.worktreeStatus, handlers['worktree.status'])
  registry.register('worktree.changes', Params.worktreeChanges, handlers['worktree.changes'])
  registry.register('worktree.diff', Params.worktreeDiff, handlers['worktree.diff'])
  registry.register('worktree.files', Params.worktreeFiles, handlers['worktree.files'])
  registry.register('worktree.findFiles', Params.worktreeFindFiles, handlers['worktree.findFiles'])
  registry.register('worktree.commit', Params.worktreeCommit, handlers['worktree.commit'])
  registry.register('worktree.stageHunk', Params.worktreeStageHunk, handlers['worktree.stageHunk'])
  registry.register('worktree.unstageHunk', Params.worktreeUnstageHunk, handlers['worktree.unstageHunk'])
  registry.register('worktree.log', Params.worktreeLog, handlers['worktree.log'])
  registry.register('worktree.mergePreview', Params.worktreeMergePreview, handlers['worktree.mergePreview'])
  registry.register('worktree.push', Params.worktreePush, handlers['worktree.push'])
  registry.register('worktree.startPoints', Params.worktreeStartPoints, handlers['worktree.startPoints'])
  return service
}
