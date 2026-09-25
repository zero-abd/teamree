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
  'project.clone',
  'project.cloneProgress',
  'project.cancelClone',
  'project.remove',
  'project.trashPreview',
  'project.trash',
  'project.setPaths',
  'project.saveSettings',
  'worktree.list',
  'worktree.get',
  'worktree.create',
  'worktree.remove',
  'worktree.forget',
  'worktree.rename',
  'worktree.status',
  'worktree.changes',
  'worktree.diff',
  'worktree.files',
  'worktree.findFiles',
  'worktree.commit',
  'worktree.stageHunk',
  'worktree.unstageHunk',
  'worktree.unstagePath',
  'worktree.discardPath',
  'worktree.discardHunk',
  'worktree.undoDiscard',
  'worktree.removed',
  'worktree.restore',
  'worktree.log',
  'worktree.showCommit',
  'worktree.compare',
  'worktree.mergePreview',
  'worktree.push',
  'worktree.update',
  'worktree.abortUpdate',
  'worktree.landing',
  'worktree.createPullRequest',
  'worktree.mergeIntoBase',
  'worktree.keep',
  'worktree.startPoints',
  'worktree.branches',
  'worktree.pullRequests',
  'worktree.setup'
] as const

export type GitMethodName = (typeof GIT_METHODS)[number]

export type GitHandlers = {
  [M in GitMethodName]: (params: ParamsOf<M>) => Promise<ResultOf<M>>
}

export function createGitHandlers(service: GitService): GitHandlers {
  return {
    // Read afresh on every list: a `git pull` can change `.teamree/project.json` under a running app.
    'project.list': async () => {
      await service.refreshProjectFiles()
      return service.listProjects()
    },
    'project.add': (params) => service.addProject(params),
    'project.clone': (params) => service.cloneProject(params),
    'project.cloneProgress': async (params) => service.cloneProgress(params),
    'project.cancelClone': async (params) => service.cancelClone(params),
    'project.remove': (params) => service.removeProject(params),
    'project.trashPreview': (params) => service.trashPreview(params),
    'project.trash': (params) => service.trashProject(params),
    'project.setPaths': (params) => service.setProjectPaths(params),
    'project.saveSettings': (params) => service.saveProjectSettings(params),
    'worktree.list': (params) => service.listWorktrees(params),
    'worktree.get': (params) => service.getWorktree(params),
    'worktree.create': (params) => service.createWorktree(params),
    'worktree.remove': (params) => service.removeWorktree(params),
    'worktree.forget': (params) => service.forgetWorktree(params),
    'worktree.rename': (params) => service.renameWorktree(params),
    'worktree.status': (params) => service.worktreeStatus(params),
    'worktree.changes': (params) => service.worktreeChanges(params),
    'worktree.diff': (params) => service.worktreeDiff(params),
    'worktree.files': (params) => service.worktreeFiles(params),
    'worktree.findFiles': (params) => service.worktreeFindFiles(params),
    'worktree.commit': (params) => service.worktreeCommit(params),
    'worktree.stageHunk': (params) => service.worktreeStageHunk(params),
    'worktree.unstageHunk': (params) => service.worktreeUnstageHunk(params),
    'worktree.unstagePath': (params) => service.worktreeUnstagePath(params),
    'worktree.discardPath': (params) => service.worktreeDiscardPath(params),
    'worktree.discardHunk': (params) => service.worktreeDiscardHunk(params),
    'worktree.undoDiscard': (params) => service.undoDiscard(params),
    'worktree.removed': (params) => service.listRemovedWorktrees(params),
    'worktree.restore': (params) => service.restoreWorktree(params),
    'worktree.log': (params) => service.worktreeLog(params),
    'worktree.showCommit': (params) => service.worktreeShowCommit(params),
    'worktree.compare': (params) => service.worktreeCompare(params),
    'worktree.mergePreview': (params) => service.worktreeMergePreview(params),
    'worktree.push': (params) => service.worktreePush(params),
    'worktree.update': (params) => service.worktreeUpdate(params),
    'worktree.abortUpdate': (params) => service.worktreeAbortUpdate(params),
    'worktree.landing': (params) => service.worktreeLanding(params),
    'worktree.createPullRequest': (params) => service.worktreeCreatePullRequest(params),
    'worktree.mergeIntoBase': (params) => service.worktreeMergeIntoBase(params),
    'worktree.keep': (params) => service.keepWorktree(params),
    'worktree.startPoints': (params) =>
      service.listStartPoints(params.projectId, params.limit === undefined ? {} : { limit: params.limit }),
    'worktree.branches': (params) => service.listBranches(params),
    'worktree.pullRequests': (params) => service.listPullRequests(params),
    'worktree.setup': (params) => service.answerSetup(params)
  }
}

export function registerGitHandlers(registry: MethodRegistry, service: GitService): GitService {
  const handlers = createGitHandlers(service)
  registry.register('project.list', Params.projectList, handlers['project.list'])
  registry.register('project.add', Params.projectAdd, handlers['project.add'])
  registry.register('project.clone', Params.projectClone, handlers['project.clone'])
  registry.register('project.cloneProgress', Params.projectCloneProgress, handlers['project.cloneProgress'])
  registry.register('project.cancelClone', Params.projectCancelClone, handlers['project.cancelClone'])
  registry.register('project.remove', Params.projectRemove, handlers['project.remove'])
  registry.register('project.trashPreview', Params.projectTrashPreview, handlers['project.trashPreview'])
  registry.register('project.trash', Params.projectTrash, handlers['project.trash'])
  registry.register('project.setPaths', Params.projectSetPaths, handlers['project.setPaths'])
  registry.register('project.saveSettings', Params.projectSaveSettings, handlers['project.saveSettings'])
  registry.register('worktree.list', Params.worktreeList, handlers['worktree.list'])
  registry.register('worktree.get', Params.worktreeGet, handlers['worktree.get'])
  registry.register('worktree.create', Params.worktreeCreate, handlers['worktree.create'])
  registry.register('worktree.remove', Params.worktreeRemove, handlers['worktree.remove'])
  registry.register('worktree.forget', Params.worktreeForget, handlers['worktree.forget'])
  registry.register('worktree.rename', Params.worktreeRename, handlers['worktree.rename'])
  registry.register('worktree.status', Params.worktreeStatus, handlers['worktree.status'])
  registry.register('worktree.changes', Params.worktreeChanges, handlers['worktree.changes'])
  registry.register('worktree.diff', Params.worktreeDiff, handlers['worktree.diff'])
  registry.register('worktree.files', Params.worktreeFiles, handlers['worktree.files'])
  registry.register('worktree.findFiles', Params.worktreeFindFiles, handlers['worktree.findFiles'])
  registry.register('worktree.commit', Params.worktreeCommit, handlers['worktree.commit'])
  registry.register('worktree.stageHunk', Params.worktreeStageHunk, handlers['worktree.stageHunk'])
  registry.register('worktree.unstageHunk', Params.worktreeUnstageHunk, handlers['worktree.unstageHunk'])
  registry.register('worktree.unstagePath', Params.worktreeUnstagePath, handlers['worktree.unstagePath'])
  registry.register('worktree.discardPath', Params.worktreeDiscardPath, handlers['worktree.discardPath'])
  registry.register('worktree.discardHunk', Params.worktreeDiscardHunk, handlers['worktree.discardHunk'])
  registry.register('worktree.undoDiscard', Params.worktreeUndoDiscard, handlers['worktree.undoDiscard'])
  registry.register('worktree.removed', Params.worktreeRemoved, handlers['worktree.removed'])
  registry.register('worktree.restore', Params.worktreeRestore, handlers['worktree.restore'])
  registry.register('worktree.log', Params.worktreeLog, handlers['worktree.log'])
  registry.register('worktree.showCommit', Params.worktreeShowCommit, handlers['worktree.showCommit'])
  registry.register('worktree.compare', Params.worktreeCompare, handlers['worktree.compare'])
  registry.register('worktree.mergePreview', Params.worktreeMergePreview, handlers['worktree.mergePreview'])
  registry.register('worktree.push', Params.worktreePush, handlers['worktree.push'])
  registry.register('worktree.update', Params.worktreeUpdate, handlers['worktree.update'])
  registry.register('worktree.abortUpdate', Params.worktreeAbortUpdate, handlers['worktree.abortUpdate'])
  registry.register('worktree.landing', Params.worktreeLanding, handlers['worktree.landing'])
  registry.register(
    'worktree.createPullRequest',
    Params.worktreeCreatePullRequest,
    handlers['worktree.createPullRequest']
  )
  registry.register('worktree.mergeIntoBase', Params.worktreeMergeIntoBase, handlers['worktree.mergeIntoBase'])
  registry.register('worktree.keep', Params.worktreeKeep, handlers['worktree.keep'])
  registry.register('worktree.startPoints', Params.worktreeStartPoints, handlers['worktree.startPoints'])
  registry.register('worktree.branches', Params.worktreeBranches, handlers['worktree.branches'])
  registry.register('worktree.pullRequests', Params.worktreePullRequests, handlers['worktree.pullRequests'])
  registry.register('worktree.setup', Params.worktreeSetup, handlers['worktree.setup'])
  return service
}
