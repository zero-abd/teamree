// The shape macOS reports events in, reproduced where it can be run.
//
// `os.tmpdir()` is `/var/folders/...` on macOS and `/var` is a symlink to
// `/private/var`, so the path a watch is set up on and the path its events
// arrive on are different strings for the same directory. Two CI failures came
// out of a filter that compared the reported name against `.teamree`, and each
// fix was another guess at what that name would be.
//
// This builds the same mismatch with a symlink, which works on any platform,
// and asserts the thing that actually matters: the watcher notices what
// `.teamree` did, through a path it was not watched under.

import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEMBERS_DIR_SEGMENTS } from './memberFile'
import { TeamreeWatcher } from './teamreeWatcher'

describe('a checkout reached through a symlink', () => {
  it('still notices .teamree arriving and going', async () => {
    const base = await mkdtemp(join(tmpdir(), 'teamree-symlink-'))
    const real = join(base, 'real')
    const seen = join(base, 'seen')
    await mkdir(real)
    await symlink(real, seen)

    let reports = 0
    let run: (() => void) | undefined
    const watcher = new TeamreeWatcher({
      onChange: () => {
        reports += 1
      },
      schedule: (task) => {
        run = task
        return () => {
          run = undefined
        }
      }
    })
    // Watched under the symlink, written through the real path — which is the
    // macOS mismatch, made on purpose.
    watcher.sync([{ id: 'p1', path: seen }])
    try {
      await mkdir(join(real, ...MEMBERS_DIR_SEGMENTS), { recursive: true })
      await writeFile(join(real, ...MEMBERS_DIR_SEGMENTS, 'bo.pub'), 'handle: bo\n', 'utf8')
      await waitFor(() => run !== undefined)
      run?.()
      expect(reports).toBeGreaterThan(0)

      const afterArrival = reports
      await rm(join(real, '.teamree'), { recursive: true, force: true })
      await waitFor(() => run !== undefined)
      run?.()
      expect(reports).toBeGreaterThan(afterArrival)
    } finally {
      watcher.close()
      await rm(base, { recursive: true, force: true })
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the watch never scheduled a report')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
