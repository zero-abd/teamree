// The id space a teammate's pane shares with your own, and the order the focus
// chord walks it in.
//
// Both matter more than they look. The ids are shared because a watched pane is
// a pane now: one `focusPane`, one close chord, one highlighted border carry
// both kinds, and the only thing keeping a `terminal.close` off somebody else's
// laptop is that the two cannot be confused. The order is the order the panes
// are drawn in, because a chord that jumped about the window would be a chord
// nobody could use twice in a row.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { isWatchedPaneId, neighbourWatchId, paneCycle, watchedPaneId, type WatchedPane } from './watchedPanes'

const watch = (projectId: string, paneId: string): WatchedPane => ({
  id: watchedPaneId(projectId, paneId),
  projectId,
  paneId,
  label: 'claude',
  handle: 'priya'
})

describe('telling a teammate’s pane from one of your own', () => {
  it('marks a watched pane, and leaves a terminal id alone', () => {
    expect(isWatchedPaneId(watchedPaneId('p1', 'priya:t7'))).toBe(true)
    expect(isWatchedPaneId('t7')).toBe(false)
  })

  // A pane id is only unique within the project it was published in: two
  // repositories can hold a teammate of the same name, and nothing on either
  // side stops them numbering a pane the same way.
  it('keeps the same pane in two projects apart', () => {
    expect(watchedPaneId('p1', 'priya:t7')).not.toBe(watchedPaneId('p2', 'priya:t7'))
  })
})

describe('the order the focus chord walks', () => {
  const tree: PaneNode = {
    kind: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [
      { kind: 'leaf', terminalId: 't1' },
      { kind: 'leaf', terminalId: 't2' }
    ]
  }

  it('is your own panes as the tree lays them out, then the teammates’ as they were opened', () => {
    expect(paneCycle(tree, [watch('p1', 'priya:t7'), watch('p1', 'ana:t2')])).toEqual([
      't1',
      't2',
      watchedPaneId('p1', 'priya:t7'),
      watchedPaneId('p1', 'ana:t2')
    ])
  })

  // A window with nothing of its own open is exactly the window somebody is
  // most likely to be watching a teammate from.
  it('is the teammates’ panes alone when this window has none of its own', () => {
    expect(paneCycle(null, [watch('p1', 'priya:t7')])).toEqual([watchedPaneId('p1', 'priya:t7')])
  })

  it('is empty when nothing is open at all, rather than a cycle of nothing', () => {
    expect(paneCycle(null, [])).toEqual([])
  })
})

describe('where the focus lands when a watched pane closes', () => {
  const panes = [watch('p1', 'a'), watch('p1', 'b'), watch('p1', 'c')]

  it('goes to the pane that takes its place on the screen', () => {
    expect(neighbourWatchId(panes, watchedPaneId('p1', 'b'))).toBe(watchedPaneId('p1', 'c'))
  })

  // So that holding the close chord walks the row rather than jumping out of it
  // on the last one.
  it('goes backwards when the pane that closed was the last', () => {
    expect(neighbourWatchId(panes, watchedPaneId('p1', 'c'))).toBe(watchedPaneId('p1', 'b'))
  })

  it('goes back to your own tree when that was the only one', () => {
    expect(neighbourWatchId([watch('p1', 'a')], watchedPaneId('p1', 'a'))).toBeNull()
  })

  it('answers nothing for a pane that was never open', () => {
    expect(neighbourWatchId(panes, watchedPaneId('p1', 'z'))).toBeNull()
  })
})
