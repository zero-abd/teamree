// The size a pty is born at: the only size a full-screen agent's first frame
// is drawn at. Asked of the pty itself, since the snapshot only repeats what
// the manager was told.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { paneCellsIn } from '../../shared/paneRoom'
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

/** A window's grid and cell, as `terminal.create` reports them. */
const AREA = { width: 1000, height: 800 }
const CELL = { width: 8, height: 16 }

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
      // A pane opened from the CLI, with no window to measure with.
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

      manager.write(pane.id, 'stty size\r')
      await waitUntil(() => manager.read(pane.id).includes(sizeLine(41, 131)), 'the resized pane to report 41x131')
    },
    TEST_TIMEOUT_MS
  )

  // zsh fills its first line to the width it was told; drawn narrower, the fill
  // wraps and leaves a reverse-video `%` above the prompt.
  it(
    'starts a split pane at the size the window measured for its half',
    async () => {
      const manager = await managerInTempDir()
      const target = manager.create({ worktreeId: WORKTREE, shell: testShell(), cols: 160, rows: 40 })
      const { terminal } = manager.split({
        terminalId: target.id,
        direction: 'row',
        command: 'stty size',
        cols: 77,
        rows: 39
      })

      expect(terminal).toMatchObject({ cols: 77, rows: 39 })
      await waitUntil(() => manager.read(terminal.id).includes(sizeLine(39, 77)), 'the half to report 39x77')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'starts an unmeasured split pane in half its target, never at the whole of it',
    async () => {
      const manager = await managerInTempDir()
      const target = manager.create({ worktreeId: WORKTREE, shell: testShell(), cols: 160, rows: 40 })
      const beside = manager.split({ terminalId: target.id, direction: 'row' }).terminal
      const below = manager.split({ terminalId: target.id, direction: 'column' }).terminal

      expect(beside.cols).toBeLessThanOrEqual(80)
      expect(beside.rows).toBe(40)
      expect(below.cols).toBe(160)
      expect(below.rows).toBeLessThanOrEqual(20)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'starts a pane with no size at its place on the grid the window last reported',
    async () => {
      const manager = await managerInTempDir()
      manager.create({ worktreeId: WORKTREE, shell: testShell(), cols: 122, rows: 47, area: AREA, cell: CELL })
      // `teamree terminal create`: no window, so no size.
      const pane = manager.create({ worktreeId: WORKTREE, shell: testShell(), command: 'stty size' })
      const expected = paneCellsIn(manager.layoutGet(WORKTREE).root, pane.id, AREA, CELL)

      expect(expected).toBeDefined()
      expect(pane).toMatchObject(expected!)
      expect(pane.cols).toBeLessThan(80)
      await waitUntil(
        () => manager.read(pane.id).includes(sizeLine(expected!.rows, expected!.cols)),
        'the CLI pane to report the size it will be drawn at'
      )
    },
    TEST_TIMEOUT_MS
  )

  it(
    'starts a CLI split on the reported grid too',
    async () => {
      const manager = await managerInTempDir()
      const target = manager.create({
        worktreeId: WORKTREE,
        shell: testShell(),
        cols: 122,
        rows: 47,
        area: AREA,
        cell: CELL
      })
      const { terminal, layout } = manager.split({ terminalId: target.id, direction: 'column' })

      expect(terminal).toMatchObject(paneCellsIn(layout.root, terminal.id, AREA, CELL)!)
    },
    TEST_TIMEOUT_MS
  )
})
