// A damaged workspace.json comes back from its backup, an unreadable pair is kept and said, and a failed save
// stays on screen until a retry lands.

import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/entities'
import { WorkspaceStore, type StoreProblem } from './workspaceStore'
import { openTestStore, removeTempDir } from './storeTestSupport'

const shop: Project = { id: 'p1', name: 'shop', path: '/repos/shop', baseRef: 'origin/main' }
const api: Project = { id: 'p2', name: 'api', path: '/repos/api', baseRef: 'origin/main' }
const CUT_SHORT = '{"projects": [{"id": "p1"'
const AT = Date.parse('2026-01-02T03:04:05.678Z')

describe('a workspace file that goes bad', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-recovery-'))
    filePath = join(directory, 'workspace.json')
  })

  afterEach(async () => {
    await removeTempDir(directory)
  })

  async function open(problems: StoreProblem[] = [], retryMs = 60_000): Promise<WorkspaceStore> {
    return openTestStore(filePath, {
      onProblem: (problem) => problems.push(problem),
      now: () => AT,
      retryMs
    })
  }

  it('keeps a copy of each write beside the file', async () => {
    const store = await open()
    store.putProject(shop)
    await store.flush()
    store.putProject(api)
    await store.flush()

    const backup = JSON.parse(await readFile(`${filePath}.bak`, 'utf8')) as { projects: Project[] }
    expect(backup.projects).toEqual([shop, api])
    expect((await readdir(directory)).sort()).toEqual(['workspace.json', 'workspace.json.bak'])
  })

  it('loads the backup when the file is cut short, and keeps the damaged bytes', async () => {
    const first = await open()
    first.putProject(shop)
    await first.flush()
    // Cut short in place, as a disk error or a sync tool would.
    await truncate(filePath, CUT_SHORT.length)

    const problems: StoreProblem[] = []
    const store = await open(problems)
    await store.flush()

    const keptAt = `${filePath}.unreadable-2026-01-02T03-04-05-678Z`
    expect(store.listProjects()).toEqual([shop])
    expect(store.problems()).toEqual([{ kind: 'restored', filePath, keptAt }])
    expect(problems.map((problem) => problem.kind)).toEqual(['unreadable', 'keptAside', 'restored'])
    expect((await readFile(keptAt, 'utf8')).length).toBe(CUT_SHORT.length)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ projects: [shop] })
  })

  it('starts empty and says so when the backup cannot be read either', async () => {
    await writeFile(filePath, CUT_SHORT, 'utf8')
    await writeFile(`${filePath}.bak`, '{', 'utf8')

    const store = await open()

    const keptAt = `${filePath}.unreadable-2026-01-02T03-04-05-678Z`
    expect(store.listProjects()).toEqual([])
    expect(store.problems()).toEqual([{ kind: 'unreadable', filePath, keptAt }])
    expect(await readFile(keptAt, 'utf8')).toBe(CUT_SHORT)
    store.putProject(shop)
    await store.flush()
    expect(await readFile(keptAt, 'utf8')).toBe(CUT_SHORT)
  })

  it('shows a failed save until a retry lands, then clears it', async () => {
    const home = join(directory, 'state')
    filePath = join(home, 'workspace.json')
    await mkdir(home)
    const problems: StoreProblem[] = []
    const store = await open(problems, 20)
    await rm(home, { recursive: true })
    await writeFile(home, 'not a directory\n', 'utf8')

    store.putProject(shop)
    await store.flush().catch(() => {})
    expect(store.problems()).toEqual([{ kind: 'saveFailed', filePath, reason: expect.any(String), diskFull: false }])

    await rm(home)
    await expect.poll(() => store.problems(), { timeout: 2_000 }).toEqual([])
    expect(problems.map((problem) => problem.kind)).toEqual(['writeFailed', 'saved'])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ projects: [shop] })
    await expect(store.flush()).resolves.toBeUndefined()
  })

  it('saves at once on Retry', async () => {
    const home = join(directory, 'state')
    filePath = join(home, 'workspace.json')
    await mkdir(home)
    const store = await open()
    await rm(home, { recursive: true })
    await writeFile(home, 'not a directory\n', 'utf8')

    store.putProject(shop)
    expect(await store.retrySave()).toBe(false)
    await rm(home)
    expect(await store.retrySave()).toBe(true)
    expect(store.problems()).toEqual([])
  })
})
