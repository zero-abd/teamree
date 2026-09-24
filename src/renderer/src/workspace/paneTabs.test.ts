import { describe, expect, it } from 'vitest'
import type { PaneNode, Terminal } from '@shared/entities'
import { leaf } from '../panes/paneLayout'
import { TONE_LABEL } from '../sidebar/agentRows'
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
    expect(tabs[1]).toEqual({
      terminalId: 'pending',
      agent: undefined,
      label: 'terminal',
      text: 'terminal',
      activity: null
    })
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

    expect(tabs.map((tab) => tab.label)).toEqual(['Claude Code', 'npm test', 'zsh'])
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

    expect(tabs.map((tab) => tab.label)).toEqual(['Claude Code 1', 'Claude Code 2', 'auth refactor'])
  })

  // The glyph names the agent, so the text beside it carries only what the glyph cannot.
  it('draws an agent by its glyph, keeping a task name and a twin’s number as text', () => {
    const tabs = paneTabs(
      row('one', 'two', 'named', 'shell'),
      byId(
        terminal({ id: 'one', agent: 'codex' }),
        terminal({ id: 'two', agent: 'codex' }),
        terminal({ id: 'named', agent: 'claude', label: 'auth refactor' }),
        terminal({ id: 'shell', title: 'npm test', foregroundAgent: 'grok' })
      )
    )

    expect(tabs.map((tab) => [tab.agent, tab.text])).toEqual([
      ['codex', '1'],
      ['codex', '2'],
      ['claude', 'auth refactor'],
      ['grok', '']
    ])
  })

  it('has nothing to show for a worktree with no panes in it', () => {
    expect(paneTabs(null, {})).toEqual([])
  })
})

describe('paneTabTitle', () => {
  it('says the name alone while nothing is known about the pane', () => {
    expect(
      paneTabTitle({ terminalId: 'a', agent: undefined, label: 'terminal', text: 'terminal', activity: null })
    ).toBe('terminal')
  })

  // Read from TONE_LABEL rather than written out again, because the hover
  // and the sidebar are describing the same dot and must use the same words.
  it('adds the word the sidebar uses for the dot, a quiet agent apart from a quiet shell', () => {
    const waiting = paneTabTitle({ terminalId: 'a', agent: 'claude', label: 'claude', text: '', activity: 'quiet' })
    const failed = paneTabTitle({
      terminalId: 'b',
      agent: undefined,
      label: 'npm test',
      text: 'npm test',
      activity: 'failed'
    })

    const shell = paneTabTitle({ terminalId: 'c', agent: undefined, label: 'zsh', text: 'zsh', activity: 'quiet' })

    expect(waiting).toBe(`claude · ${TONE_LABEL.quiet}`)
    expect(failed).toBe(`npm test · ${TONE_LABEL.failed}`)
    expect(shell).toBe('zsh · idle')
    expect(waiting).toBe('claude · stopped')
  })
})

describe('file tabs', () => {
  it('names a file leaf after its file, with no activity and its kind said', () => {
    const root: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'docs/NOTES.md' }]
    }
    const tabs = paneTabs(root, { a: terminal({ id: 'a', title: 'zsh' }) })
    expect(tabs[1]).toEqual({
      terminalId: 'file:1',
      agent: undefined,
      label: 'NOTES.md',
      text: 'NOTES.md',
      activity: null,
      kind: 'file'
    })
    expect(tabs[0]?.kind).toBeUndefined()
    expect(paneTabTitle(tabs[1]!)).toBe('NOTES.md')
  })

  it('names a column of one file after it, and says when it is the preview', () => {
    const column: PaneNode = {
      kind: 'split',
      direction: 'column',
      sizes: [1],
      children: [{ kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'src/app.ts' }],
      tabs: true,
      shown: 'file:1',
      preview: 'file:1'
    }
    const [tab] = paneTabs(column, {})
    expect(tab).toEqual({
      terminalId: 'file:1',
      agent: undefined,
      label: 'app.ts',
      text: 'app.ts',
      activity: null,
      kind: 'file',
      files: ['file:1'],
      preview: true
    })
    expect(paneTabTitle(tab!)).toBe('app.ts')
  })

  it('calls a column of several files Files, jumping to the shown one', () => {
    const file = (id: string, path: string): PaneNode => ({ kind: 'leaf', terminalId: id, pane: 'file', path })
    const column: PaneNode = {
      kind: 'split',
      direction: 'column',
      sizes: [0.25, 0.25, 0.25, 0.25],
      children: [file('file:1', 'a.ts'), file('file:2', 'src/app.ts'), file('file:3', 'b.ts'), file('file:4', 'c.ts')],
      tabs: true,
      shown: 'file:2'
    }
    const root: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), column] }
    const tabs = paneTabs(root, { a: terminal({ id: 'a', title: 'zsh' }) })
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toEqual({
      terminalId: 'file:2',
      agent: undefined,
      label: 'Files 4',
      text: 'Files',
      activity: null,
      kind: 'file',
      files: ['file:1', 'file:2', 'file:3', 'file:4'],
      names: ['a.ts', 'app.ts', 'b.ts', 'c.ts']
    })
    expect(paneTabTitle(tabs[1]!)).toBe('a.ts, app.ts, b.ts, c.ts')
  })

  // `startTask` labels the agent's pane with the stored name, cut to "Add a subtract function to claude".
  it('calls the pane named after its worktree by the worktree title', () => {
    const worktree = {
      name: 'Add a subtract function to claude',
      branch: 'add-a-subtract-function-to-claude',
      task: 'Add a subtract function to src/math.ts'
    }
    const tabs = paneTabs(
      row('a', 'b'),
      byId(terminal({ id: 'a', agent: 'claude', label: worktree.name }), terminal({ id: 'b' })),
      worktree
    )

    expect(tabs.map((tab) => tab.text)).toEqual(['Add a subtract function to src/math.ts', 'bash'])
  })
})
