import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BaseFetcher } from '../../git/baseFetch'
import { createGitRunner } from '../../git/gitProcess'
import { GitService } from '../../git/gitService'
import { createTempRepo, type TempRepo } from '../../git/testRepository'
import { fetchProjectNow } from './fetchHandler'

let repo: TempRepo | undefined
let service: GitService | undefined

afterEach(async () => {
  await service?.dispose()
  await repo?.cleanup()
})

it('Fetch Now says why origin could not be fetched, and clears it once it can', async () => {
  repo = await createTempRepo({ withRemote: true })
  const git = new GitService({ worktreesRoot: repo.worktreesRoot })
  service = git
  const project = await git.addProject({ path: repo.repoPath })
  const bases = new BaseFetcher({
    runner: createGitRunner(),
    projects: () => [],
    onMoved: () => {},
    onState: (id, state) => git.recordFetch(id, state)
  })
  const updates: string[] = []
  git.events.on((event) => {
    if (event.type === 'project.updated') updates.push(event.project.fetch?.failure ?? 'ok')
  })

  // The last time origin/main moved, three hours back; a commit's own date must not stand in for it.
  const reflog = path.join(repo.repoPath, '.git', 'logs', 'refs', 'remotes', 'origin', 'main')
  const movedAt = Math.floor(Date.now() / 1000) - 3 * 60 * 60
  await writeFile(reflog, (await readFile(reflog, 'utf8')).replace(/> \d+ /, `> ${movedAt} `))
  const origin = path.join(repo.base, 'origin.git')
  await rename(origin, `${origin}-gone`)
  const failed = (await fetchProjectNow(git, bases, project.id)).fetch
  expect(failed?.failure).toBe('not-found')
  expect(failed?.fetchedAt).toBe(movedAt * 1000)

  await rename(`${origin}-gone`, origin)
  const fetched = await fetchProjectNow(git, bases, project.id)
  expect(fetched.fetch?.failure).toBeUndefined()
  expect(fetched.fetch?.fetchedAt).toBeGreaterThan(0)
  expect(git.listProjects()[0]?.fetch).toEqual(fetched.fetch)
  expect(updates).toEqual(['not-found', 'ok'])
  bases.stop()
})
