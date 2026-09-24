// The store's Commit against a real repository: what lands in HEAD is git's answer, not the
// store's idea of it.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parsePatch } from '@shared/patch'
import { createTempRepo, type TempRepo } from '../../../main/git/testRepository'
import { commitWorktree } from '../../../main/git/worktreeCommit'
import { applyHunk, type HunkStageOptions } from '../../../main/git/worktreeHunk'
import { readWorktreeChanges } from '../../../main/git/worktreeChanges'

const live = vi.hoisted(() => ({ repo: null as TempRepo | null }))

vi.mock('../runtimeClient/currentRuntimeClient', () => {
  const repo = (): TempRepo => live.repo!
  // The store's params, less the id the runtime would resolve to a path.
  const call = async (method: string, params: object): Promise<unknown> => {
    const at = { worktreeId: 'wt', worktreePath: repo().repoPath }
    if (method === 'worktree.commit') {
      return commitWorktree(repo().runner, { ...(params as { message: string }), ...at })
    }
    if (method === 'worktree.stageHunk') {
      const { path, hunk } = params as Pick<HunkStageOptions, 'path' | 'hunk'>
      return applyHunk(repo().runner, { ...at, path, hunk, staged: true })
    }
    throw new Error(`not wired: ${method}`)
  }
  return { runtimeClient: { call } }
})

import { useWorkspaceStore } from './workspaceStore'

const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
const EDITED = LINES.map((line, index) => (index === 1 ? 'TWO' : index === 18 ? 'NINETEEN' : line))

let repo: TempRepo
beforeEach(async () => {
  repo = await createTempRepo()
  live.repo = repo
  await repo.write('.gitignore', 'secret.env\n')
  await repo.write('f.txt', `${LINES.join('\n')}\n`)
  await repo.write('g.txt', 'g\n')
  await repo.commit('files')
})
afterEach(async () => {
  live.repo = null
  await repo.cleanup()
})

/** What the panel would list right now. */
const refresh = async (ticked: string[] = []): Promise<void> => {
  const changes = await readWorktreeChanges(repo.runner, { worktreeId: 'wt', worktreePath: repo.repoPath })
  useWorkspaceStore.setState({
    activeWorktreeId: 'wt',
    changes: { wt: changes },
    statuses: {},
    stagedPaths: ticked,
    notices: [],
    rightPanelOpen: true,
    rightPanelTab: 'changes'
  })
}

const committed = (): Promise<string> => repo.git(['show', '--name-only', '--format=', 'HEAD'])
const stageFirstHunk = async (): Promise<void> => {
  const [file] = parsePatch(`${await repo.git(['diff', '--no-color', '--', 'f.txt'])}\n`)
  expect(file?.hunks).toHaveLength(2)
  await useWorkspaceStore.getState().applyHunk('wt', 'f.txt', file!.hunks[0]!, true)
}

it('commits the one staged hunk and leaves the other in the working tree', async () => {
  await repo.write('f.txt', `${EDITED.join('\n')}\n`)
  await repo.write('notes.md', 'scratch\n')
  await stageFirstHunk()
  await refresh()

  expect(await useWorkspaceStore.getState().commitStaged('only the top')).toBe(true)

  expect(await committed()).toBe('f.txt')
  expect(await repo.git(['show', 'HEAD:f.txt'])).toBe(LINES.map((l, i) => (i === 1 ? 'TWO' : l)).join('\n'))
  const left = await repo.git(['diff', '--no-color'])
  expect(left).toContain('+NINETEEN')
  expect(left).not.toContain('+TWO')
  expect(await repo.git(['status', '--porcelain'])).toContain('?? notes.md')
})

it('stages the rest of a partly staged file that is ticked', async () => {
  await repo.write('f.txt', `${EDITED.join('\n')}\n`)
  await stageFirstHunk()
  await refresh(['f.txt'])

  expect(await useWorkspaceStore.getState().commitStaged('the whole file')).toBe(true)

  expect(await repo.git(['show', 'HEAD:f.txt'])).toBe(EDITED.join('\n'))
  expect(await repo.git(['status', '--porcelain'])).toBe('')
})

it('commits every change, untracked included and ignored left out, when nothing is staged or ticked', async () => {
  await repo.write('f.txt', `${EDITED.join('\n')}\n`)
  await repo.write('new.ts', 'export {}\n')
  await repo.write('secret.env', 'TOKEN=1\n')
  await refresh()

  expect(await useWorkspaceStore.getState().commitStaged('everything')).toBe(true)

  expect((await committed()).split('\n').sort()).toEqual(['f.txt', 'new.ts'])
  expect(await repo.git(['status', '--porcelain', '--ignored'])).toBe('!! secret.env')
})

it('commits the ticked rows and what was already staged, nothing else', async () => {
  await repo.write('f.txt', `${EDITED.join('\n')}\n`)
  await repo.write('g.txt', 'G\n')
  await repo.write('h.txt', 'h\n')
  await repo.git(['add', 'h.txt'])
  await refresh(['g.txt'])

  expect(await useWorkspaceStore.getState().commitStaged('g and h')).toBe(true)

  expect((await committed()).split('\n').sort()).toEqual(['g.txt', 'h.txt'])
  expect(await repo.git(['status', '--porcelain'])).toBe('M f.txt')
})

it('commits a tree of only untracked files', async () => {
  await repo.write('a.ts', 'a\n')
  await repo.write('dir/b.ts', 'b\n')
  await refresh()

  expect(await useWorkspaceStore.getState().commitStaged('new files')).toBe(true)

  expect((await committed()).split('\n').sort()).toEqual(['a.ts', 'dir/b.ts'])
  expect(await repo.git(['status', '--porcelain'])).toBe('')
})

const said = (): string[] => useWorkspaceStore.getState().notices.map((notice) => notice.text)

it('says nothing when All was ticked, a folded folder of new files included', async () => {
  for (let index = 0; index < 21; index += 1) await repo.write(`gen/f${index}.ts`, 'x\n')
  await repo.write('g.txt', 'G\n')
  await refresh()
  expect(useWorkspaceStore.getState().changes.wt?.changes.map((change) => change.path)).toEqual(['g.txt', 'gen/'])
  useWorkspaceStore.getState().setAllStaged(true)

  expect(await useWorkspaceStore.getState().commitStaged('all of it')).toBe(true)

  expect(await repo.git(['status', '--porcelain'])).toBe('')
  expect(said()).toEqual([])
})

it('says so when the commit took in a file staged outside the panel', async () => {
  await repo.write('g.txt', 'G\n')
  await repo.write('h.txt', 'h\n')
  await repo.git(['add', 'h.txt'])
  await refresh(['g.txt'])

  expect(await useWorkspaceStore.getState().commitStaged('g and h')).toBe(true)

  expect(said()).toEqual(['Also committed 1 staged file'])
})
