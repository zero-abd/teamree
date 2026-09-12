// Layouts are durable, terminals are not. Every stored layout is therefore stale
// the moment the app restarts, and a leaf pointing at a dead terminal renders as
// a permanently empty pane. These cover the reconciliation that prevents that.

import { describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import { TerminalSessionManager } from './session-manager'

/** A repository preloaded with layouts, as if restored from disk. */
function restoredLayouts(layouts: Layout[]): {
  getLayout: (id: string) => Layout | undefined
  putLayout: (layout: Layout) => Layout
  listLayouts: () => Layout[]
} {
  const byWorktree = new Map(layouts.map((layout) => [layout.worktreeId, layout]))
  return {
    getLayout: (id) => byWorktree.get(id),
    putLayout: (layout) => {
      byWorktree.set(layout.worktreeId, layout)
      return layout
    },
    listLayouts: () => [...byWorktree.values()]
  }
}

describe('layout reconciliation at startup', () => {
  it('empties a layout whose terminals all died with the previous run', () => {
    const layouts = restoredLayouts([
      {
        worktreeId: 'w1',
        root: { kind: 'leaf', terminalId: 'term_gone' },
        focusedTerminalId: 'term_gone'
      }
    ])
    const manager = new TerminalSessionManager({ layouts })

    expect(manager.reconcileLayouts()).toBe(1)
    expect(layouts.getLayout('w1')?.root).toBeNull()
    expect(layouts.getLayout('w1')?.focusedTerminalId).toBeNull()
  })

  it('drops only the dead leaves from a split and collapses what is left', () => {
    const layouts = restoredLayouts([
      {
        worktreeId: 'w1',
        root: {
          kind: 'split',
          direction: 'row',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'leaf', terminalId: 'term_gone' },
            { kind: 'leaf', terminalId: 'term_gone_too' }
          ]
        },
        focusedTerminalId: 'term_gone'
      }
    ])
    const manager = new TerminalSessionManager({ layouts })

    manager.reconcileLayouts()
    expect(layouts.getLayout('w1')?.root).toBeNull()
  })

  it('leaves a layout alone when it has nothing stale in it', () => {
    const layouts = restoredLayouts([{ worktreeId: 'w1', root: null, focusedTerminalId: null }])
    const manager = new TerminalSessionManager({ layouts })

    expect(manager.reconcileLayouts()).toBe(0)
  })

  it('does nothing when the repository cannot enumerate', () => {
    const manager = new TerminalSessionManager({
      layouts: { getLayout: () => undefined, putLayout: (layout) => layout }
    })

    expect(manager.reconcileLayouts()).toBe(0)
  })
})
