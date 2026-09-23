// The size a pty is born at.
//
// A program that draws a whole screen asks its terminal how big it is once, at
// startup, and lays the frame out to the answer. So the size `terminal.create`
// carries is not a hint the emulator will correct in a moment — it is the only
// size the agent's first frame is ever drawn at. Asserted by asking the pty
// itself rather than by reading the snapshot back, because the snapshot is this
// manager repeating what it was told and the ioctl is the thing that matters.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canSpawnPty, testShell, waitUntil } from './pty-test-support'
import { TerminalSessionManager } from './session-manager'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_1'

const managers: TerminalSessionManager[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function managerInTempDir(): Promise<TerminalSessionManager> {
  const checkout = await mkdtemp(join(tmpdir(), 'teamree-start-size-'))
  dirs.push(checkout)
  const manager = new TerminalSessionManager({ resolveWorktreeCwd: () => checkout })
  managers.push(manager)
  return manager
}

/** What `stty size` prints: rows first, then columns. */
function sizeLine(rows: number, cols: number): string {
  return `${rows} ${cols}`
}

describePty('the size a pane starts at', () => {
  it(
    'spawns the pty at the size the caller measured',
    async () => {
      const manager = await managerInTempDir()
      const pane = manager.create({
        worktreeId: WORKTREE,
        shell: testShell(),
        cols: 173,
        rows: 47,
        command: 'stty size'
      })

      expect(pane).toMatchObject({ cols: 173, rows: 47 })
      // The program's own view of its terminal, which is what a full-screen
      // agent reads before it draws anything.
      await waitUntil(
        () => manager.read(pane.id).includes(sizeLine(47, 173)),
        'the pane’s own program to report the size it was started at'
      )
    },
    TEST_TIMEOUT_MS
  )

  it(
    'falls back to 80x24 for a create that carries no size',
    async () => {
      const manager = await managerInTempDir()
      // A pane opened from the CLI, which has no window to measure with. It
      // starts at the runtime's default and is resized by the first view that
      // mounts on it; the default is kept honest here so that "the view will
      // fix it" stays a claim about a known starting point.
      const pane = manager.create({ worktreeId: WORKTREE, shell: testShell(), command: 'stty size' })

      expect(pane).toMatchObject({ cols: 80, rows: 24 })
      await waitUntil(() => manager.read(pane.id).includes(sizeLine(24, 80)), 'the pane’s own program to report 24x80')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'tells the program when the pane is resized after it started',
    async () => {
      const manager = await managerInTempDir()
      const pane = manager.create({ worktreeId: WORKTREE, shell: testShell() })
      manager.resize(pane.id, 131, 41)

      // This is the half a view mounting on a CLI-opened pane relies on, so it
      // is asked of the pty rather than of the record.
      manager.write(pane.id, 'stty size\r')
      await waitUntil(() => manager.read(pane.id).includes(sizeLine(41, 131)), 'the resized pane to report 41x131')
    },
    TEST_TIMEOUT_MS
  )
})
