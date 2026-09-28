// worktree.search through the real registry and dispatcher: the scope decides
// which checkouts are read, and the stream ends with `done` or an unsubscribe.

import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import type { WorktreeSearchEvent } from '../../shared/search'
import type { StreamEvent } from '../../shared/protocol'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { openTestStore, removeTempDir } from '../store/storeTestSupport'
import { GitService } from './gitService'
import { registerGitHandlers } from './handlers'
import { registerSearchHandler } from './searchHandler'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(scratch.splice(0).map((dir) => removeTempDir(dir)))
})

async function wire(rg: string | null = null) {
  const repo = await createTempRepo()
  repos.push(repo)
  await repo.write('src/limits.ts', 'export const limit = 3\n')
  await repo.commit('limits')
  const store = await openTestStore(path.join(repo.base, 'workspace.json'))
  const subscriptions = new SubscriptionHub()
  const frames: StreamEvent[] = []
  subscriptions.openConnection('test', (frame) => frames.push(frame))
  const registry = new MethodRegistry(createRuntimeContext({ version: '0.0.0-test', store, subscriptions }))
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, store })
  services.push(service)
  registerGitHandlers(registry, service)
  registerSearchHandler(registry, service, { rg: () => rg })

  const dispatch = createDispatcher(registry)
  let counter = 0
  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    counter += 1
    const response = await dispatch({ id: `r${counter}`, method, params }, { connectionId: 'test' })
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result as T
  }
  const task = async (projectId: string, name: string): Promise<Worktree> => {
    const created = await call<Worktree>('worktree.create', { projectId, name })
    await service.whenSettled(created.id)
    return created
  }
  const events = (subscription: string): WorktreeSearchEvent[] =>
    frames.filter((frame) => frame.stream === subscription).map((frame) => frame.event as WorktreeSearchEvent)
  const finished = async (subscription: string): Promise<WorktreeSearchEvent[]> => {
    for (let waited = 0; waited < 5000; waited += 20) {
      if (events(subscription).some((event) => event.type === 'done')) return events(subscription)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('the search never finished')
  }
  return { repo, call, task, finished, events, subscriptions }
}

describe('worktree.search', () => {
  it('searches one task, or every task of the project', async () => {
    const { repo, call, task, finished, subscriptions } = await wire()
    const project = await call<Project>('project.add', { path: repo.repoPath })
    const auth = await task(project.id, 'auth refresh')
    const rate = await task(project.id, 'rate limits')
    await repo.write('src/middleware.ts', 'limit()\n', rate.path)

    const one = await call<{ subscription: string }>('worktree.search', { worktreeId: auth.id, query: 'limit' })
    const oneEvents = await finished(one.subscription)
    const hitsOf = (list: WorktreeSearchEvent[]): string[] =>
      list
        .flatMap((event) => (event.type === 'hits' ? event.files : []))
        .map(
          (file) => `${file.worktreeId === auth.id ? 'auth' : file.worktreeId === rate.id ? 'rate' : '?'}:${file.path}`
        )
        .sort()
    expect(hitsOf(oneEvents)).toEqual(['auth:src/limits.ts'])
    expect(oneEvents.at(-1)).toMatchObject({ type: 'done', matches: 1, engine: 'git', truncated: false })
    // The stream closed itself after `done`.
    expect(subscriptions.countFor('test')).toBe(0)

    const all = await call<{ subscription: string }>('worktree.search', { projectId: project.id, query: 'limit' })
    expect(hitsOf(await finished(all.subscription))).toEqual([
      'auth:src/limits.ts',
      'rate:src/limits.ts',
      'rate:src/middleware.ts'
    ])
  })

  it('refuses a scope that names both or neither, and an unknown project', async () => {
    const { call } = await wire()
    await expect(call('worktree.search', { query: 'x' })).rejects.toThrow(/invalid_params/)
    await expect(call('worktree.search', { query: 'x', worktreeId: 'a', projectId: 'b' })).rejects.toThrow(
      /invalid_params/
    )
    await expect(call('worktree.search', { query: 'x', projectId: 'nope' })).rejects.toThrow(/not_found/)
  })

  it('stops the engine when unsubscribed', async () => {
    const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'teamree-rg-'))
    scratch.push(dir)
    const pidFile = path.join(dir, 'pid')
    const rg = path.join(dir, 'rg')
    await writeFile(rg, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`)
    await chmod(rg, 0o755)
    const { repo, call, task, events, subscriptions } = await wire(rg)
    const project = await call<Project>('project.add', { path: repo.repoPath })
    const auth = await task(project.id, 'auth')

    const { subscription } = await call<{ subscription: string }>('worktree.search', {
      worktreeId: auth.id,
      query: 'x'
    })
    let pid = 0
    for (let waited = 0; pid === 0 && waited < 3000; waited += 20) {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      if (pid === 0) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(pid).toBeGreaterThan(0)

    expect(subscriptions.unsubscribe('test', subscription)).toBe(true)
    const alive = async (): Promise<boolean> => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let waited = 0; (await alive()) && waited < 2000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(await alive()).toBe(false)
    expect(events(subscription).some((event) => event.type === 'done')).toBe(false)
  })
})
