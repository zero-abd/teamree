import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_FILE_UNREADABLE } from '../../shared/projectSettings'
import { readProjectFile, writeProjectFile } from './projectFile'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function checkout(contents?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamree-project-file-'))
  roots.push(root)
  if (contents !== undefined) {
    await mkdir(join(root, '.teamree'), { recursive: true })
    await writeFile(join(root, '.teamree', 'project.json'), contents)
  }
  return root
}

describe('.teamree/project.json', () => {
  it('reads as nothing when there is no file', async () => {
    expect(await readProjectFile(await checkout())).toEqual({})
  })

  it('reads back what was written', async () => {
    const root = await checkout()
    const settings = {
      startFrom: 'origin/dev',
      setupCommand: 'npm ci',
      linkedPaths: ['node_modules'],
      copiedPaths: ['.env']
    }
    expect(await writeProjectFile(root, settings)).toBe('.teamree/project.json')
    expect(await readProjectFile(root)).toEqual({ settings })
    expect(await readFile(join(root, '.teamree', 'project.json'), 'utf8')).toContain('"setupCommand": "npm ci"')
  })

  it('ignores a malformed file whole, with one line to say so', async () => {
    for (const bad of ['{ not json', '[]', '{"setupCommand": 7}', '{"linkedPaths": ["../outside"]}']) {
      expect(await readProjectFile(await checkout(bad)), bad).toEqual({ problem: PROJECT_FILE_UNREADABLE })
    }
  })

  it('ignores fields it does not know, so a newer file still reads', async () => {
    const root = await checkout('{"setupCommand": "npm ci", "later": true}')
    expect(await readProjectFile(root)).toEqual({ settings: { setupCommand: 'npm ci' } })
  })
})
