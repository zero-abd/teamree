// A pane opened from a group's `+` joins that group as a tab, at the group's size, and leaves it on close.

import { afterEach, describe, expect, it } from 'vitest'
import { createTerminalService, type TerminalService } from './method-handlers'
import { canSpawnPty } from './pty-test-support'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_groups'
const AREA = { width: 1000, height: 800 }
const CELL = { width: 8, height: 16 }

const services: TerminalService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
})

function newService(): TerminalService {
  const service = createTerminalService({ resolveWorktreeCwd: () => process.cwd() })
  services.push(service)
  return service
}

describePty('a tab opened in a group', () => {
  it(
    'joins the group of the pane named, shown, born at that pane’s size',
    async () => {
      const service = newService()
      const create = service.handlers['terminal.create']
      const a = await create({ worktreeId: WORKTREE, area: AREA, cell: CELL })
      const b = await create({ worktreeId: WORKTREE, area: AREA, cell: CELL })
      const tab = await create({ worktreeId: WORKTREE, tabOf: a.id, area: AREA, cell: CELL })

      const layout = await service.handlers['layout.get']({ worktreeId: WORKTREE })
      expect(layout.root).toMatchObject({
        kind: 'split',
        children: [
          { tabs: true, shown: tab.id, children: [{ terminalId: a.id }, { terminalId: tab.id }] },
          { terminalId: b.id }
        ]
      })
      expect(layout.focusedTerminalId).toBe(tab.id)
      const sizeOf = async (id: string) =>
        (await service.handlers['terminal.list']({ worktreeId: WORKTREE })).find((pane) => pane.id === id)
      // The group is as wide as `b`'s half of the row; `a` itself was never resized, having no window.
      const [beside, added] = [await sizeOf(b.id), await sizeOf(tab.id)]
      expect(added?.cols).toBe(beside?.cols)

      await service.handlers['terminal.close']({ terminalId: tab.id })
      const after = await service.handlers['layout.get']({ worktreeId: WORKTREE })
      expect(after.root).toMatchObject({ kind: 'split', children: [{ terminalId: a.id }, { terminalId: b.id }] })
    },
    TEST_TIMEOUT_MS
  )
})
