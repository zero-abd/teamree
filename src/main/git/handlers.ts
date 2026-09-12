// THE SEAM. This is the whole surface the runtime wires up.
//
// In src/main/runtime/handlers/registerHandlers.ts:
//
//   import { GitService, registerGitHandlers } from '../../git'
//   registerGitHandlers(registry, new GitService({ store: registry.context.store }))
//
// That follows the runtime's own convention — `registry.register(method, schema,
// handler)` with the schema from `Params` in src/shared/methods.ts — and passing
// the workspace store makes project and worktree records persist with the rest
// of the workspace. Leave `store` out and the service keeps records in memory.
//
// Handlers receive already-validated params and resolve with exactly the result
// the contract declares. Everything they throw is a GitServiceError, which is a
// RuntimeError, so the dispatcher preserves its ErrorCode.
//
// These capabilities have no method in the frozen contract and are reached on
// the service directly:
//   git.events.on(listener)             creating -> ready | failed transitions
//   git.cancelWorktreeCreate(id)        abort a create that is still running
//   git.listStartPoints(projectId)      what the start-from picker can offer
//   git.describeStartPoint(id, ref)     resolve one start point without creating
//   git.startPointFor(worktreeId)       how a create read its start point
//
// The three start-point calls are the picker's data source. They are plain
// service methods because adding `worktree.startPoints` to the contract is a
// decision for whoever owns src/shared; the shapes are stable and adding that
// method later is a one-line handler here. Until then a renderer reaches them
// through the main process directly, and the CLI cannot see them at all.
//
// `createGitHandlers(service)` returns the same handlers as a plain object, for
// a caller that would rather wire them up itself.

import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { GitService } from './gitService'

export const GIT_METHODS = [
  'project.list',
  'project.add',
  'project.remove',
  'worktree.list',
  'worktree.get',
  'worktree.create',
  'worktree.remove',
  'worktree.status',
  'worktree.changes',
  'worktree.diff',
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
    'worktree.list': (params) => service.listWorktrees(params),
    'worktree.get': (params) => service.getWorktree(params),
    'worktree.create': (params) => service.createWorktree(params),
    'worktree.remove': (params) => service.removeWorktree(params),
    'worktree.status': (params) => service.worktreeStatus(params),
    'worktree.changes': (params) => service.worktreeChanges(params),
    'worktree.diff': (params) => service.worktreeDiff(params),
    'worktree.startPoints': (params) =>
      service.listStartPoints(params.projectId, params.limit === undefined ? {} : { limit: params.limit })
  }
}

export function registerGitHandlers(registry: MethodRegistry, service: GitService): GitService {
  const handlers = createGitHandlers(service)
  registry.register('project.list', Params.projectList, handlers['project.list'])
  registry.register('project.add', Params.projectAdd, handlers['project.add'])
  registry.register('project.remove', Params.projectRemove, handlers['project.remove'])
  registry.register('worktree.list', Params.worktreeList, handlers['worktree.list'])
  registry.register('worktree.get', Params.worktreeGet, handlers['worktree.get'])
  registry.register('worktree.create', Params.worktreeCreate, handlers['worktree.create'])
  registry.register('worktree.remove', Params.worktreeRemove, handlers['worktree.remove'])
  registry.register('worktree.status', Params.worktreeStatus, handlers['worktree.status'])
  registry.register('worktree.changes', Params.worktreeChanges, handlers['worktree.changes'])
  registry.register('worktree.diff', Params.worktreeDiff, handlers['worktree.diff'])
  registry.register('worktree.startPoints', Params.worktreeStartPoints, handlers['worktree.startPoints'])
  return service
}
