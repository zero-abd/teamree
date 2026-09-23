import { describe, expect, it } from 'vitest'
import type { PaneNode, Terminal } from '@shared/entities'
import { leaf } from '../panes/paneLayout'
import { ACTIVITY_LABEL } from '../sidebar/agentRows'
import { paneTabs, paneTabTitle } from './paneTabs'

function terminal(overrides: Partial<Terminal> & { id: string }): Terminal {
  return {
    worktreeId: 'wt1',
    title: 'bash',
    cwd: '/checkouts/wt1',
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...overrides
  }
}

/** The records as the store holds them: by id, in whatever order they arrived. */
const byId = (...panes: Terminal[]): Record<string, Terminal> =>
  Object.fromEntries(panes.map((pane) => [pane.id, pane]))

const row = (...terminalIds: string[]): PaneNode => ({
  kind: 'split',
  direction: 'row',
  sizes: terminalIds.map(() => 1 / terminalIds.length),
  children: terminalIds.map((terminalId) => leaf(terminalId))
})

describe('paneTabs', () => {
  // The tree is the order the panes read on screen and the order
  // `focus-next-pane` steps through them. The records are keyed by id, so the
  // two are built here to disagree.
  it('lists the panes in the order the split tree puts them, not the order they were opened in', () => {
    const root: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }]
    }

    const tabs = paneTabs(root, byId(terminal({ id: 'c' }), terminal({ id: 'a' }), terminal({ id: 'b' })))

    expect(tabs.map((tab) => tab.terminalId)).toEqual(['a', 'b', 'c'])
  })

  // The strip has to agree with the board about how many panes are there, and
  // a pane is on the board from the moment the split happens — a beat before
  // the runtime's record of it comes back.
  it('still gives a tab to a leaf whose terminal record has not arrived', () => {
    const tabs = paneTabs(row('a', 'pending'), byId(terminal({ id: 'a', title: 'npm test' })))

    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toEqual({ terminalId: 'pending', label: 'terminal', activity: null })
  })

  it('calls a pane by its agent, and one without an agent whatever the sidebar calls it', () => {
    const tabs = paneTabs(
      row('agent', 'titled', 'default'),
      byId(
        terminal({ id: 'agent', agent: 'claude', title: 'node' }),
        terminal({ id: 'titled', title: 'npm test' }),
        // bash's default title is the user, the host and the path. `paneLabel`
        // collapses it to the shell's own name, so a strip that worked labels
        // out for itself would give this pane away by showing the whole thing.
        terminal({ id: 'default', title: 'abd@studio: ~/repos/teamree', shell: '/bin/zsh' })
      )
    )

    expect(tabs.map((tab) => tab.label)).toEqual(['claude', 'npm test', 'zsh'])
  })

  // The same two facts `activityOf` reads, and nothing else: whether the
  // process is still there, and whether bytes are still arriving.
  it('reads a busy pane as working, a quiet one as waiting, and an exit by its status', () => {
    const tabs = paneTabs(
      row('busy', 'silent', 'clean', 'crashed'),
      byId(
        terminal({ id: 'busy', busy: true }),
        terminal({ id: 'silent' }),
        terminal({ id: 'clean', running: false, exitCode: 0 }),
        terminal({ id: 'crashed', running: false, exitCode: 1 })
      )
    )

    expect(tabs.map((tab) => tab.activity)).toEqual(['working', 'quiet', 'done', 'failed'])
  })

  // The strip is the other half of the same answer: a sidebar that numbers its
  // rows and a tab strip that does not would be two answers about three panes.
  it('numbers unnamed panes that would read identically, and leaves named ones whole', () => {
    const tabs = paneTabs(
      row('one', 'two', 'named'),
      byId(
        terminal({ id: 'one', agent: 'claude', title: 'node' }),
        terminal({ id: 'two', agent: 'claude', title: 'node' }),
        terminal({ id: 'named', agent: 'claude', title: 'node', label: 'auth refactor' })
      )
    )

    expect(tabs.map((tab) => tab.label)).toEqual(['claude 1', 'claude 2', 'auth refactor'])
  })

  it('has nothing to show for a worktree with no panes in it', () => {
    expect(paneTabs(null, {})).toEqual([])
  })
})

describe('paneTabTitle', () => {
  it('says the name alone while nothing is known about the pane', () => {
    expect(paneTabTitle({ terminalId: 'a', label: 'terminal', activity: null })).toBe('terminal')
  })

  // Read from ACTIVITY_LABEL rather than written out again, because the hover
  // and the sidebar are describing the same dot and must use the same words.
  it('adds the sentence the sidebar uses for the state', () => {
    const waiting = paneTabTitle({ terminalId: 'a', label: 'claude', activity: 'quiet' })
    const failed = paneTabTitle({ terminalId: 'b', label: 'npm test', activity: 'failed' })

    expect(waiting).toBe(`claude · ${ACTIVITY_LABEL.quiet}`)
    expect(failed).toBe(`npm test · ${ACTIVITY_LABEL.failed}`)
  })
})
