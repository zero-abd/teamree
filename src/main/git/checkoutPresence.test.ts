import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkoutPresence, commonGitDir, dropRegistration, linkedCheckout } from './checkoutPresence'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function withCheckout(): Promise<{ repo: TempRepo; checkout: string }> {
  const repo = await createTempRepo()
  repos.push(repo)
  const checkout = path.join(repo.worktreesRoot, 'feat')
  await repo.git(['worktree', 'add', '-b', 'feat', checkout])
  return { repo, checkout }
}

describe('checkoutPresence', () => {
  it('is present for a linked checkout where git put it', async () => {
    const { checkout } = await withCheckout()
    expect(await checkoutPresence(checkout)).toBe('present')
  })

  it('is gone once the folder is deleted', async () => {
    const { checkout } = await withCheckout()
    await rm(checkout, { recursive: true, force: true })
    expect(await checkoutPresence(checkout)).toBe('gone')
  })

  it('is foreign for an empty folder in its place', async () => {
    const { checkout } = await withCheckout()
    await rm(checkout, { recursive: true, force: true })
    await mkdir(checkout)
    expect(await checkoutPresence(checkout)).toBe('foreign')
  })

  it('is foreign for another repository in its place', async () => {
    const { repo, checkout } = await withCheckout()
    await rm(checkout, { recursive: true, force: true })
    await mkdir(checkout)
    await repo.git(['init'], checkout)
    expect(await checkoutPresence(checkout)).toBe('foreign')
  })

  it('is foreign at a moved folder until git is told, and present after a repair', async () => {
    const { repo, checkout } = await withCheckout()
    const moved = path.join(repo.base, 'moved')
    await rename(checkout, moved)
    expect(await checkoutPresence(checkout)).toBe('gone')
    expect(await checkoutPresence(moved)).toBe('foreign')
    await repo.git(['worktree', 'repair', moved])
    expect(await checkoutPresence(moved)).toBe('present')
  })
})

describe('linkedCheckout', () => {
  it('names the repository a moved folder belongs to', async () => {
    const { repo, checkout } = await withCheckout()
    const moved = path.join(repo.base, 'moved')
    await rename(checkout, moved)
    expect((await linkedCheckout(moved))?.commonDir).toBe(await commonGitDir(repo.repoPath))
  })

  it('names nothing for the primary checkout or a plain folder', async () => {
    const { repo } = await withCheckout()
    expect(await linkedCheckout(repo.repoPath)).toBeUndefined()
    expect(await linkedCheckout(repo.base)).toBeUndefined()
  })
})

describe('dropRegistration', () => {
  it('drops git’s entry for a folder that holds something else now, and leaves the folder', async () => {
    const { repo, checkout } = await withCheckout()
    await rm(checkout, { recursive: true, force: true })
    await mkdir(checkout)
    await writeFile(path.join(checkout, 'mine.txt'), 'not yours\n')

    expect(await dropRegistration(repo.repoPath, checkout)).toBe(true)

    expect(await repo.git(['worktree', 'list', '--porcelain'])).not.toContain(checkout)
    expect(await readdir(checkout)).toEqual(['mine.txt'])
  })

  it('drops only that entry, leaving another missing one for its own record', async () => {
    const { repo, checkout } = await withCheckout()
    const other = path.join(repo.worktreesRoot, 'other')
    await repo.git(['worktree', 'add', '-b', 'other', other])
    await rm(checkout, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })

    await dropRegistration(repo.repoPath, checkout)

    const listed = await repo.git(['worktree', 'list', '--porcelain'])
    expect([listed.includes(checkout), listed.includes(other)]).toEqual([false, true])
  })
})
