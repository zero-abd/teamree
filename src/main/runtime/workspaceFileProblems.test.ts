// A runtime opened on a damaged workspace.json tells the window: the backup's projects, and a problem to show.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/entities'
import { startRuntime, WORKSPACE_FILE_NAME, type Runtime } from './startRuntime'

const call = { connectionId: 'test' }
const shop: Project = { id: 'p1', name: 'shop', path: '/repos/shop', baseRef: 'origin/main' }
const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function start(userDataDir: string): Promise<Runtime> {
  const runtime = await startRuntime({
    userDataDir,
    version: '0.0.0-test',
    serveCli: false,
    serveRenderer: false,
    serveTeamwork: false,
    checkForUpdates: false
  })
  runtimes.push(runtime)
  return runtime
}

async function result(runtime: Runtime, method: string): Promise<unknown> {
  const response = (await runtime.dispatch({ id: method, method, params: {} }, call)) as { result?: unknown }
  return response.result
}

describe('a damaged workspace file', () => {
  it('opens on the backup and says so to the window', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'teamree-damaged-'))
    dirs.push(userDataDir)
    const file = join(userDataDir, WORKSPACE_FILE_NAME)
    await writeFile(file, '{"projects": [{"id"', 'utf8')
    await writeFile(`${file}.bak`, JSON.stringify({ projects: [shop] }), 'utf8')

    const runtime = await start(userDataDir)

    expect(await result(runtime, 'project.list')).toMatchObject([{ id: 'p1', name: 'shop' }])
    expect(await result(runtime, 'workspace.problems')).toEqual([
      { kind: 'restored', filePath: file, keptAt: expect.stringContaining(`${WORKSPACE_FILE_NAME}.unreadable-`) }
    ])
  })

  it('has nothing to say about a file that reads', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'teamree-damaged-'))
    dirs.push(userDataDir)

    const runtime = await start(userDataDir)

    expect(await result(runtime, 'workspace.problems')).toEqual([])
    expect(await result(runtime, 'workspace.retrySave')).toEqual({ saved: true })
  })
})
