// worktree.search: resolves the worktrees to search, then streams hits on a
// subscription until the search ends. Unsubscribing is the cancel.

import { Params } from '../../shared/methods'
import type { ParamsOf } from '../../shared/methods'
import type { WorktreeSearchEvent } from '../../shared/search'
import { conflict, notFound } from '../runtime/runtimeError'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { GitService } from './gitService'
import { startSearch, type SearchTarget } from './worktreeSearch'

export type SearchHandlerOptions = {
  /** Ripgrep's path when installed; asked per search, so installing it needs no restart. */
  rg: () => string | null
  git?: string
}

export function registerSearchHandler(registry: MethodRegistry, git: GitService, options: SearchHandlerOptions): void {
  registry.register('worktree.search', Params.worktreeSearch, async (params, call) => {
    const targets = await searchTargets(git, params)
    const rg = options.rg()
    const subscription = registry.context.subscriptions.subscribe(call.connectionId, (channel) => {
      const emit = (event: WorktreeSearchEvent): void => channel.emit(event)
      const run = startSearch({
        targets,
        query: params.query,
        ...(params.regex === undefined ? {} : { regex: params.regex }),
        ...(params.caseSensitive === undefined ? {} : { caseSensitive: params.caseSensitive }),
        ...(params.wholeWord === undefined ? {} : { wholeWord: params.wholeWord }),
        ...(params.include === undefined ? {} : { include: params.include }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        rg,
        git: options.git ?? (process.env.TEAMREE_GIT_BINARY || 'git'),
        onHits: (files) => emit({ type: 'hits', files })
      })
      void run.done.then(({ cancelled, ...summary }) => {
        if (cancelled) return
        emit({ type: 'done', ...summary })
        channel.close()
      })
      return () => run.cancel()
    })
    return { subscription }
  })
}

async function searchTargets(git: GitService, params: ParamsOf<'worktree.search'>): Promise<SearchTarget[]> {
  if (params.worktreeId !== undefined) {
    const worktree = await git.getWorktree({ worktreeId: params.worktreeId })
    if (worktree.state !== 'ready' || worktree.missing === true) {
      throw conflict(`worktree "${worktree.name}" has no checkout to search`)
    }
    return [{ worktreeId: worktree.id, path: worktree.path }]
  }
  const projectId = params.projectId ?? ''
  if (!git.listProjects().some((project) => project.id === projectId)) throw notFound(`no project ${projectId}`)
  const worktrees = await git.listWorktrees({ projectId })
  return worktrees
    .filter((worktree) => worktree.state === 'ready' && worktree.missing !== true)
    .map((worktree) => ({ worktreeId: worktree.id, path: worktree.path }))
}
