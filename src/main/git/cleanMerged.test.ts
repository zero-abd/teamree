// Clean Up Merged against a real repository: what counts as merged (a child's base is its parent), what
// is held back, the order things go in, and that every removal can be restored.

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree, WorktreeCleanup } from '../../shared/entities'
import { GitService, type GitServiceOptions } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Setup = { repo: TempRepo; service: GitService; project: Project }

async function setup(options: GitServiceOptions = {}, withRemote = false): Promise<Setup> {
  const repo = await createTempRepo({ withRemote })
  repos.push(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...options })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  return { repo, service, project }
}

async function ready(s: Setup, name: string, parentId?: string): Promise<Worktree> {
  const pending = await s.service.createWorktree({
    projectId: s.project.id,
    name,
    ...(parentId === undefined ? {} : { parentId })
  })
  const settled = await s.service.whenSettled(pending.id)
  if (settled.state !== 'ready') throw new Error(`"${name}" failed: ${settled.error ?? 'unknown'}`)
  return settled
}

/** A worktree with one commit of its own. */
async function worked(s: Setup, name: string, parentId?: string): Promise<Worktree> {
  const worktree = await ready(s, name, parentId)
  await s.repo.write(`${worktree.branch.replace(/\W+/g, '-')}.txt`, `${name}\n`, worktree.path)
  await s.repo.commit(name, worktree.path)
  return worktree
}

/** Merges `branch` into whatever is checked out at `into` (the main checkout by default). */
async function merge(s: Setup, branch: string, into = s.repo.repoPath): Promise<void> {
  await s.repo.git(['merge', '--no-ff', '--no-edit', branch], into)
}

const names = (entries: readonly { worktree: Worktree }[]): string[] => entries.map((entry) => entry.worktree.name)
const reasons = (cleanup: WorktreeCleanup): Record<string, string> =>
  Object.fromEntries(cleanup.kept.map((entry) => [entry.worktree.name, entry.reason]))

describe('what Clean Up Merged finds', () => {
  it('lists a branch merged into the base, not one still ahead of it nor one that never committed', async () => {
    const s = await setup()
    const shipped = await worked(s, 'shipped')
    await worked(s, 'in progress')
    await ready(s, 'untouched')
    await merge(s, shipped.branch)

    const plan = await s.service.cleanMerged({ projectId: s.project.id, dryRun: true })

    expect(plan).toMatchObject({ projectId: s.project.id, dryRun: true, kept: [] })
    expect(names(plan.removed)).toEqual(['shipped'])
    expect(existsSync(shipped.path)).toBe(true)
  })

  it('counts a merge into the local base branch that is not pushed yet', async () => {
    const s = await setup({}, true)
    expect(s.project.baseRef).toBe('origin/main')
    const local = await worked(s, 'local')
    await merge(s, local.branch)

    const plan = await s.service.cleanMerged({ projectId: s.project.id, dryRun: true })

    expect(names(plan.removed)).toEqual(['local'])
  })

  it('measures a child against its parent, and takes it before the parent', async () => {
    const s = await setup()
    const parent = await worked(s, 'parent')
    const child = await worked(s, 'child', parent.id)
    await merge(s, child.branch, parent.path)

    // The parent has not landed; its merged child can go alone.
    const alone = await s.service.cleanMerged({ projectId: s.project.id, dryRun: true })
    expect(names(alone.removed)).toEqual(['child'])

    await merge(s, parent.branch)
    const both = await s.service.cleanMerged({ projectId: s.project.id, dryRun: true })
    expect(names(both.removed)).toEqual(['child', 'parent'])
  })

  it('keeps a merged parent whose child stays', async () => {
    const s = await setup()
    const parent = await worked(s, 'parent')
    await worked(s, 'child', parent.id)
    await merge(s, parent.branch)

    const plan = await s.service.cleanMerged({ projectId: s.project.id, dryRun: true })

    expect(plan.removed).toEqual([])
    expect(reasons(plan)).toEqual({ parent: '1 child stays' })
  })

  // Known limit: a squash or rebase merge leaves no ancestry, so the branch reads as unmerged.
  it('does not see a squash merge', async () => {
    const s = await setup()
    const squashed = await worked(s, 'squashed')
    await s.repo.git(['merge', '--squash', squashed.branch])
    await s.repo.git(['commit', '--no-verify', '-m', 'Squash merge'])

    const plan = await s.service.cleanMerged({ projectId: s.project.id, dryRun: true })

    expect(plan.removed).toEqual([])
    expect(plan.kept).toEqual([])
  })
})

describe('what Clean Up Merged never takes', () => {
  it('holds back uncommitted work and an agent mid-turn, and names why', async () => {
    let working = ''
    const s = await setup({ agentWorking: (worktreeId) => worktreeId === working })
    const dirty = await worked(s, 'dirty')
    const busy = await worked(s, 'busy')
    await merge(s, dirty.branch)
    await merge(s, busy.branch)
    await s.repo.write('draft.txt', 'unsaved\n', dirty.path)
    working = busy.id

    const done = await s.service.cleanMerged({ projectId: s.project.id })

    expect(done.removed).toEqual([])
    expect(reasons(done)).toEqual({ dirty: 'Uncommitted changes', busy: 'Agent working' })
    expect(existsSync(dirty.path) && existsSync(busy.path)).toBe(true)
  })

  it('skips a branch with commits made after its merge', async () => {
    const s = await setup()
    const later = await worked(s, 'later')
    await merge(s, later.branch)
    await s.repo.write('more.txt', 'more\n', later.path)
    await s.repo.commit('after the merge', later.path)

    const done = await s.service.cleanMerged({ projectId: s.project.id })

    expect(done).toMatchObject({ removed: [], kept: [] })
    expect(existsSync(later.path)).toBe(true)
  })

  it("takes only what was chosen, never a teammate's, and keeps a chosen parent whose child was not", async () => {
    const s = await setup()
    const parent = await worked(s, 'parent')
    const child = await worked(s, 'child', parent.id)
    const other = await worked(s, 'other')
    await merge(s, child.branch, parent.path)
    await merge(s, parent.branch)
    await merge(s, other.branch)

    const done = await s.service.cleanMerged({
      projectId: s.project.id,
      worktreeIds: [parent.id, 'peer:alice:wt-1']
    })

    expect(done.removed).toEqual([])
    expect(reasons(done)).toEqual({ parent: '1 child stays' })
    const left = (await s.service.listWorktrees({ projectId: s.project.id })).map((worktree) => worktree.name)
    expect(left.sort()).toEqual(['child', 'other', 'parent'])
  })
})

describe('removing and restoring', () => {
  it('removes children first, keeps a copy of each, and every copy restores with the tree as it was', async () => {
    const s = await setup()
    const parent = await worked(s, 'parent')
    const child = await worked(s, 'child', parent.id)
    const other = await worked(s, 'other')
    await merge(s, child.branch, parent.path)
    await merge(s, parent.branch)
    await s.repo.write('build/out.txt', 'ignored\n', other.path)
    await s.repo.write('.gitignore', 'build/\n', other.path)
    await s.repo.git(['add', '.gitignore'], other.path)
    await s.repo.git(['commit', '--no-verify', '-m', 'ignore build'], other.path)
    await merge(s, other.branch)

    const plan = await s.service.cleanMerged({ projectId: s.project.id, dryRun: true })
    expect(plan.removed.find((entry) => entry.worktree.name === 'other')?.ignored).toBe(1)

    const done = await s.service.cleanMerged({ projectId: s.project.id })

    expect(names(done.removed)).toEqual(['child', 'parent', 'other'])
    expect(done.removed.every((entry) => typeof entry.trashId === 'string')).toBe(true)
    expect(await s.service.listWorktrees({ projectId: s.project.id })).toEqual([])
    for (const worktree of [parent, child, other]) expect(existsSync(worktree.path)).toBe(false)

    // Parents first, so each child finds its parent back.
    for (const entry of [...done.removed].reverse()) {
      await s.service.restoreWorktree({ projectId: s.project.id, removedId: entry.trashId as string })
    }
    const back = await s.service.listWorktrees({ projectId: s.project.id })
    expect(back.map((worktree) => worktree.name).sort()).toEqual(['child', 'other', 'parent'])
    expect(back.find((worktree) => worktree.id === child.id)?.parentId).toBe(parent.id)
  })
})
