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
// Two capabilities have no method in the frozen contract and are reached on the
// service directly:
//   git.events.on(listener)             creating -> ready | failed transitions
//   git.cancelWorktreeCreate(id)        abort a create that is still running
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
  'worktree.status'
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
    'worktree.status': (params) => service.worktreeStatus(params)
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
  return service
}
