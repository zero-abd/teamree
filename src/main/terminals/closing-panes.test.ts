// Panes closed in quick succession while a window writes back the tree it last saw: no leaf may
// outlive its terminal, and × on one that did must still take it away.

import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import { createTerminalService, type TerminalService } from './method-handlers'
import { terminalIdsIn } from './pane-tree'
import { canSpawnPty } from './pty-test-support'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_close'

const services: TerminalService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
})

function newService(layouts?: Map<string, Layout>): TerminalService {
  const service = createTerminalService({
    resolveWorktreeCwd: () => process.cwd(),
    ...(layouts === undefined
      ? {}
      : {
          layouts: {
            getLayout: (worktreeId) => layouts.get(worktreeId),
            putLayout: (layout) => {
              layouts.set(layout.worktreeId, layout)
              return layout
            },
            listLayouts: () => [...layouts.values()]
          }
        })
  })
  services.push(service)
  return service
}

async function openPanes(service: TerminalService, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    ids.push((await service.handlers['terminal.create']({ worktreeId: WORKTREE })).id)
  }
  return ids
}

async function shownPanes(service: TerminalService): Promise<string[]> {
  return terminalIdsIn((await service.handlers['layout.get']({ worktreeId: WORKTREE })).root)
}

describePty('closing panes in quick succession', () => {
  it(
    'keeps closed panes out of the tree when a stale tree is written back between the closes',
    async () => {
      const service = newService()
      const [a, b, c, d] = await openPanes(service, 4)
      // What the window holds while its closes are in flight: focus and resize write it back.
      const stale = await service.handlers['layout.get']({ worktreeId: WORKTREE })
      const writeBack = () => service.handlers['layout.set'](stale)

      await Promise.all([
        service.handlers['terminal.close']({ terminalId: a! }),
        writeBack(),
        service.handlers['terminal.close']({ terminalId: b! }),
        writeBack(),
        service.handlers['terminal.close']({ terminalId: c! }),
        writeBack()
      ])
      expect(await shownPanes(service)).toEqual([d])

      await writeBack()
      expect(await shownPanes(service)).toEqual([d])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'answers a close of a pane that is already closing or closed',
    async () => {
      const service = newService()
      const [a, b] = await openPanes(service, 2)

      const closes = [a!, a!, a!].map((terminalId) => service.handlers['terminal.close']({ terminalId }))
      expect(await Promise.all(closes)).toEqual([{ closed: true }, { closed: true }, { closed: true }])
      expect(await service.handlers['terminal.close']({ terminalId: a! })).toEqual({ closed: true })
      expect(await shownPanes(service)).toEqual([b])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'takes out a stored leaf that has no terminal behind it when it is closed',
    async () => {
      const layouts = new Map<string, Layout>()
      const service = newService(layouts)
      const [live] = await openPanes(service, 1)
      layouts.set(WORKTREE, {
        worktreeId: WORKTREE,
        root: {
          kind: 'split',
          direction: 'row',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'leaf', terminalId: live! },
            { kind: 'leaf', terminalId: 'term_orphan' }
          ]
        },
        focusedTerminalId: 'term_orphan'
      })

      expect(await service.handlers['terminal.close']({ terminalId: 'term_orphan' })).toEqual({ closed: true })
      expect(terminalIdsIn(layouts.get(WORKTREE)!.root)).toEqual([live])
      expect(layouts.get(WORKTREE)!.focusedTerminalId).toBe(live)
    },
    TEST_TIMEOUT_MS
  )
})

describe('a stored tree naming terminals that are gone', () => {
  const file = { kind: 'leaf' as const, terminalId: 'file:1', pane: 'file' as const, path: 'NOTES.md' }
  const stranded: Layout = {
    worktreeId: WORKTREE,
    root: {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [{ kind: 'leaf', terminalId: 'term_gone' }, file]
    },
    focusedTerminalId: 'term_gone'
  }

  it('heals on read and saves the healed tree', async () => {
    const layouts = new Map([[WORKTREE, stranded]])
    const service = newService(layouts)

    const healed = { worktreeId: WORKTREE, root: file, focusedTerminalId: null }
    expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual(healed)
    expect(layouts.get(WORKTREE)).toEqual(healed)
  })

  it('is never saved', async () => {
    const layouts = new Map<string, Layout>()
    const service = newService(layouts)

    await service.handlers['layout.set'](stranded)
    expect(layouts.get(WORKTREE)).toEqual({ worktreeId: WORKTREE, root: file, focusedTerminalId: null })
  })
})
