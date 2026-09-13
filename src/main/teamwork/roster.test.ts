import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatMemberFile } from './memberFile'
import { membersDirectory, readRoster } from './roster'

const ADA = 'PkQtFYttlX7oLD8c/tYpNlHWLIflye3t6tMGm0I4iRk='
const GRACE = 'tOZqe8RgnJt2KzVOWEfPkfYHQpB1i0Jt7Ojb9vDfjW4='

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teamree-roster-'))
  roots.push(root)
  const directory = membersDirectory(root)
  if (Object.keys(files).length > 0) await mkdir(directory, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content, 'utf8')
  }
  return root
}

const member = (handle: string, publicKey: string, addedAt = '2026-09-13'): string =>
  formatMemberFile({ handle, publicKey, addedAt })

describe('reading a project roster', () => {
  it('reads a repository nobody has joined as empty rather than as an error', async () => {
    const roster = await readRoster(await project())

    expect(roster).toEqual({ entries: [], problems: [] })
  })

  it('lists every key in the directory, by handle', async () => {
    const root = await project({ 'grace.pub': member('grace', GRACE), 'ada.pub': member('ada', ADA) })

    const roster = await readRoster(root)

    expect(roster.entries.map((entry) => entry.handle)).toEqual(['ada', 'grace'])
    expect(roster.entries[0]).toEqual({
      handle: 'ada',
      publicKey: ADA,
      addedAt: '2026-09-13',
      file: '.teamree/members/ada.pub'
    })
    expect(roster.problems).toEqual([])
  })

  it('refuses a roster entry it cannot parse rather than dropping the list', async () => {
    const root = await project({
      'ada.pub': member('ada', ADA),
      'broken.pub': 'this file is a mess\n',
      'grace.pub': member('grace', GRACE)
    })

    const roster = await readRoster(root)

    expect(roster.entries.map((entry) => entry.handle)).toEqual(['ada', 'grace'])
    expect(roster.problems).toHaveLength(1)
    expect(roster.problems[0]?.file).toBe('.teamree/members/broken.pub')
  })

  it('refuses a file whose contents name somebody other than its file name', async () => {
    const root = await project({ 'ada.pub': member('mallory', ADA) })

    const roster = await readRoster(root)

    expect(roster.entries).toEqual([])
    expect(roster.problems[0]?.reason).toBe('names "mallory" but is filed under "ada"')
  })

  it('refuses a second handle claiming a key another file already claims', async () => {
    const root = await project({ 'ada.pub': member('ada', ADA), 'mallory.pub': member('mallory', ADA) })

    const roster = await readRoster(root)

    expect(roster.entries.map((entry) => entry.handle)).toEqual(['ada'])
    expect(roster.problems[0]).toEqual({
      file: '.teamree/members/mallory.pub',
      reason: 'has the same key as "ada"'
    })
  })

  it('refuses a file named something teamree would never have filed a key under', async () => {
    const root = await project({ 'Ada Lovelace.pub': member('ada', ADA) })

    const roster = await readRoster(root)

    expect(roster.entries).toEqual([])
    expect(roster.problems[0]?.reason).toBe('the file name is not a handle teamree would have written')
  })

  it('ignores whatever else the directory happens to contain', async () => {
    const root = await project({ 'ada.pub': member('ada', ADA), 'README.md': '# who is here\n' })

    const roster = await readRoster(root)

    expect(roster.entries).toHaveLength(1)
    expect(roster.problems).toEqual([])
  })
})
