// A git write that meets another process's index.lock: one quiet retry a second later, then a notice
// with Retry, and Clear Lock only when the runtime says the lock may go.

import { rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitServiceError } from '../../../main/git/errors'
import { createGitHandlers } from '../../../main/git/handlers'
import { GitService } from '../../../main/git/gitService'
import { STALE_LOCK_MS } from '../../../main/git/indexLock'
import { createTempRepo, type TempRepo } from '../../../main/git/testRepository'
import { readWorktreeChanges } from '../../../main/git/worktreeChanges'
import { ErrorCode } from '@shared/protocol'
import type { PatchHunk } from '@shared/patch'

const live = vi.hoisted(() => ({ call: null as null | ((method: string, params: object) => Promise<unknown>) }))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: { call: (method: string, params: object) => live.call!(method, params) }
}))

import { LOCK_RETRY_MS, useWorkspaceStore } from './workspaceStore'

const LOCKED = 'Another git process holds the lock'
const store = () => useWorkspaceStore.getState()
const lockNotices = () => store().notices.filter((notice) => notice.lock !== undefined)

beforeEach(() => {
  useWorkspaceStore.setState({
    notices: [],
    dialog: null,
    stagedPaths: [],
    rightPanelOpen: true,
    rightPanelTab: 'changes'
  })
})

describe('against a real repository', () => {
  let repo: TempRepo
  let service: GitService
  let worktreeId: string
  let checkout: string

  beforeEach(async () => {
    repo = await createTempRepo()
    service = new GitService({ worktreesRoot: repo.worktreesRoot, gitProcesses: async () => [] })
    const project = await service.addProject({ path: repo.repoPath })
    const made = await service.whenSettled((await service.createWorktree({ projectId: project.id, name: 'Lock' })).id)
    worktreeId = made.id
    checkout = made.path
    const handlers = createGitHandlers(service) as unknown as Record<string, (params: object) => Promise<unknown>>
    live.call = async (method, params) => {
      const handler = handlers[method]
      if (handler === undefined) throw new Error(`not wired: ${method}`)
      return handler(params)
    }
    await repo.write('notes.md', 'n\n', checkout)
    const changes = await readWorktreeChanges(repo.runner, { worktreeId, worktreePath: checkout })
    useWorkspaceStore.setState({ activeWorktreeId: worktreeId, changes: { [worktreeId]: changes } })
  })
  afterEach(async () => {
    live.call = null
    await service.dispose()
    await repo.cleanup()
  })

  const lockIndex = async (ageMs = 0): Promise<string> => {
    const lockPath = path.resolve(checkout, await repo.git(['rev-parse', '--git-path', 'index.lock'], checkout))
    await writeFile(lockPath, '')
    const at = new Date(Date.now() - ageMs)
    await utimes(lockPath, at, at)
    return lockPath
  }
  const head = (): Promise<string> => repo.git(['log', '-1', '--format=%s'], checkout)

  it('commits once a lock that clears within a second has gone, saying nothing', async () => {
    const lockPath = await lockIndex()
    setTimeout(() => void rm(lockPath), LOCK_RETRY_MS / 3)

    expect(await store().commitStaged('notes')).toBe(true)
    expect(await head()).toBe('notes')
    expect(lockNotices()).toEqual([])
  })

  it('says a lock that stays is held, offers no Clear Lock while it is fresh, and Retry commits once it is gone', async () => {
    const lockPath = await lockIndex()

    expect(await store().commitStaged('notes')).toBe(false)
    expect(lockNotices()).toMatchObject([{ text: LOCKED, lock: { worktreeId, lockPath, clearable: false } }])

    await rm(lockPath)
    await store().retryLocked(worktreeId)
    expect(await head()).toBe('notes')
    expect(lockNotices()).toEqual([])
  }, 10_000)

  it('offers Clear Lock for a stale lock nobody holds, asks first, then clears it and commits', async () => {
    const lockPath = await lockIndex(STALE_LOCK_MS + 1_000)

    expect(await store().commitStaged('notes')).toBe(false)
    expect(lockNotices()).toMatchObject([{ lock: { clearable: true } }])

    store().askClearLock(worktreeId, lockPath)
    expect(store().dialog).toEqual({ kind: 'clear-lock', worktreeId, lockPath })
    await store().clearLock(worktreeId, lockPath)
    expect(store().dialog).toBeNull()
    expect(await head()).toBe('notes')
    expect(lockNotices()).toEqual([])
  }, 10_000)
})

describe('each git write', () => {
  const lockPath = '/repo/.git/index.lock'
  const locked = () => new GitServiceError(ErrorCode.GitFailed, 'raw', { kind: 'locked', lockPath })
  const hunk = { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] } as unknown as PatchHunk
  const calls: string[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    calls.length = 0
    live.call = async (method) => {
      calls.push(method)
      if (method === 'worktree.lock') return { lockPath, exists: true, ageMs: 0, gitRunning: true, clearable: false }
      throw locked()
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    live.call = null
  })

  const cases: [string, string, () => Promise<unknown>][] = [
    ['stage', 'worktree.stageHunk', () => store().applyHunk('w1', 'f.txt', hunk, true)],
    ['unstage', 'worktree.unstagePath', () => store().unstagePath('w1', 'f.txt')],
    ['discard', 'worktree.discardPath', () => store().discardChange('w1', 'f.txt')],
    ['update', 'worktree.update', () => store().updateWorktree('w1')],
    ['merge', 'worktree.mergeIntoBase', () => store().mergeIntoBase('w1')]
  ]

  it.each(cases)('%s tries twice, then says the lock is held and Retry tries again', async (_, method, act) => {
    const done = act()
    await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS)
    await done
    expect(calls.filter((each) => each === method)).toHaveLength(2)
    expect(lockNotices()).toMatchObject([{ text: LOCKED, lock: { worktreeId: 'w1', lockPath, clearable: false } }])
    expect(store().notices.map((notice) => notice.text)).toEqual([LOCKED])

    const again = store().retryLocked('w1')
    await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS)
    await again
    expect(calls.filter((each) => each === method)).toHaveLength(4)
  })

  it('answers the merge dialog with the lock, and sets no update error for it', async () => {
    const merging = store().mergeIntoBase('w1')
    const updating = store().updateWorktree('w1')
    await vi.advanceTimersByTimeAsync(LOCK_RETRY_MS)
    expect(await merging).toBe(LOCKED)
    expect(await updating).toBeNull()
    expect(store().updateErrors.w1).toBeUndefined()
  })
})
