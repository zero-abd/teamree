import { describe, expect, it } from 'vitest'
import type { CliStatus, InstalledAgent, Project, UpdateState, Worktree } from '@shared/entities'
import { menuBarSpec } from '../menu/menuBar'
import {
  buildPaletteItems,
  fileItem,
  filterPalette,
  moveSelection,
  paletteGroups,
  paletteKey,
  rankFiles,
  readStoredRecent,
  RECENT_KEPT,
  score,
  trailing,
  withRecent,
  writeStoredRecent,
  type PaletteItem
} from './paletteModel'

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    projectId: 'p1',
    name: overrides.id,
    branch: `task/${overrides.id}`,
    path: `/checkouts/${overrides.id}`,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 0,
    ...overrides
  }
}

const projects: Project[] = [
  { id: 'p1', name: 'atlas', path: '/repos/atlas', baseRef: 'origin/main' },
  { id: 'p2', name: 'ledger', path: '/repos/ledger', baseRef: 'origin/main' }
]

const agent = (kind: InstalledAgent['kind']): InstalledAgent => ({
  kind,
  command: kind,
  binary: `/usr/local/bin/${kind}`
})

const updateState = (overrides: Partial<UpdateState> = {}): UpdateState => ({
  current: '0.1.0',
  checkable: true,
  automatic: true,
  available: null,
  checking: false,
  checkedAt: null,
  problem: null,
  ...overrides
})

const context = (
  overrides: Partial<Parameters<typeof buildPaletteItems>[0]> = {}
): Parameters<typeof buildPaletteItems>[0] => ({
  worktrees: [],
  projects,
  activeWorktreeId: null,
  agents: [],
  defaultAgent: '',
  update: null,
  cli: null,
  hintFor: () => '',
  ...overrides
})

describe('buildPaletteItems', () => {
  // The row said the stored "Add a subtract function to claude", and `perf` hinted `perf`.
  it('names a worktree as the sidebar does, hinting the branch only when it says more', () => {
    const task = 'Add a subtract function to src/math.ts'
    const items = buildPaletteItems(
      context({
        worktrees: [
          worktree({
            id: 'run',
            name: 'Add a subtract function to claude',
            branch: 'add-a-subtract-function-to-claude',
            task
          }),
          worktree({ id: 'perf', name: 'perf', branch: 'perf' })
        ]
      })
    )

    const rows = items.filter((item) => item.kind === 'worktree')
    expect(rows.map((item) => [item.label, item.hint])).toEqual([
      [`claude · ${task}`, ''],
      ['perf', '']
    ])
    expect(rows[0]?.search).toContain('add-a-subtract-function-to-claude')
  })

  // A search for the open worktree's task used to find only its sibling.
  it('offers the worktree already open too, after the others and marked current', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'here' }), worktree({ id: 'elsewhere' })],
        activeWorktreeId: 'here'
      })
    )

    const rows = items.filter((item) => item.kind === 'worktree')
    expect(rows.map((item) => [item.id, item.detail])).toEqual([
      ['elsewhere', 'atlas'],
      ['here', 'atlas · current']
    ])
  })

  it('makes a worktree findable by its branch and its project, not just its name', () => {
    const [item] = buildPaletteItems(context({ worktrees: [worktree({ id: 'w1', name: 'login fix' })] }))

    expect(item?.search).toContain('login fix')
    expect(item?.search).toContain('task/w1')
    expect(item?.search).toContain('atlas')
  })

  it('says what a worktree is doing when it is not simply ready', () => {
    const [item] = buildPaletteItems(context({ worktrees: [worktree({ id: 'w1', state: 'creating' })] }))

    expect(item?.detail).toContain('creating')
  })

  it('puts worktrees before actions, since jumping is what it is opened for', () => {
    const items = buildPaletteItems(context({ worktrees: [worktree({ id: 'w1' })] }))

    expect(items[0]?.kind).toBe('worktree')
    expect(items.some((item) => item.kind === 'action')).toBe(true)
  })

  // Somebody hunting for the pane that needs them will type what they are
  // after — the state, not the name of the view.
  it('finds the all-panes view by the words a person would reach for it with', () => {
    const items = buildPaletteItems(context())

    for (const query of ['all panes', 'agents', 'waiting', 'dashboard']) {
      expect(filterPalette(items, query)[0]).toMatchObject({ kind: 'action', id: 'open-dashboard' })
    }
  })

  // The toolbar used to carry one button per agent, and the palette is where
  // that went: invisible until it is asked for, so it costs no width, and it
  // is where somebody looks for an action they know the app has.
  it('offers every agent this machine has, and none it does not', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' })],
        activeWorktreeId: 'w1',
        agents: [agent('claude'), agent('codex')]
      })
    )

    const agents = items.filter((item) => item.kind === 'agent')
    expect(agents.map((item) => item.id)).toEqual(['claude', 'codex'])
    expect(agents.map((item) => item.label)).toEqual(['Start Claude Code Here', 'Start Codex Here'])
  })

  // A row that promises a pane in a directory that is not there is the same
  // broken promise as one for an agent nobody has installed.
  it('offers no agent in a worktree whose checkout is gone from disk', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', missing: true }), worktree({ id: 'w2', missing: true })],
        activeWorktreeId: 'w1',
        agents: [agent('claude')]
      })
    )
    expect(items.filter((item) => item.kind === 'agent')).toEqual([])
    // And the other one's row says why it is not the ordinary kind of row.
    expect(items.find((item) => item.kind === 'worktree' && item.id === 'w2')?.detail).toContain('missing')
  })

  // The palette opens with the first row under the cursor, so which agent is
  // first is which agent gets started.
  it('puts the agent this machine’s owner always uses first', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' })],
        activeWorktreeId: 'w1',
        agents: [agent('claude'), agent('codex')],
        defaultAgent: 'codex'
      })
    )

    expect(items.filter((item) => item.kind === 'agent').map((item) => item.id)).toEqual(['codex', 'claude'])
  })

  it('leaves the order alone when the preferred agent is not installed here', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' })],
        activeWorktreeId: 'w1',
        agents: [agent('claude'), agent('codex')],
        defaultAgent: 'gemini'
      })
    )

    expect(items.filter((item) => item.kind === 'agent').map((item) => item.id)).toEqual(['claude', 'codex'])
  })

  it('offers no agent row when the machine has none installed', () => {
    const items = buildPaletteItems(context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1' }))

    expect(items.some((item) => item.kind === 'agent')).toBe(false)
  })

  // A row is a promise that pressing Return does something, and `startAgent`
  // acts on the active worktree: with none open, or with one whose checkout is
  // still being made, there is nowhere for the pane to go.
  it('offers no agent row when there is no ready worktree to start one in', () => {
    const installed = [agent('claude')]

    expect(buildPaletteItems(context({ agents: installed })).some((item) => item.kind === 'agent')).toBe(false)
    expect(
      buildPaletteItems(
        context({ worktrees: [worktree({ id: 'w1', state: 'creating' })], activeWorktreeId: 'w1', agents: installed })
      ).some((item) => item.kind === 'agent')
    ).toBe(false)
  })

  // Both start an agent and only one of them does it here, so somebody unsure
  // which they want has to be able to tell the rows apart — and to find this
  // one by the word they would reach for.
  it('leaves naming the worktree on screen to its group, and is found by the word "here"', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' })],
        activeWorktreeId: 'w1',
        agents: [agent('claude')]
      })
    )

    const [found] = items.filter((item) => item.kind === 'agent')
    expect(found === undefined ? undefined : trailing(found)).toBe('')
    for (const query of ['claude', 'start claude', 'claude here', 'claude this worktree']) {
      expect(filterPalette(items, query)[0]).toMatchObject({ kind: 'agent', id: 'claude' })
    }
  })

  it('puts the agents after the worktrees and before the rest of the actions', () => {
    const items = buildPaletteItems(
      context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1', agents: [agent('claude')] })
    )

    expect(items.map((item) => item.kind).indexOf('agent')).toBe(items.map((item) => item.kind).indexOf('action') - 1)
  })

  // The menu has the same command, under About, where a Mac user looks for it.
  // This is the other way in, for somebody whose hands are already on the
  // palette — and the only way to the preference, which has no other home.
  it('offers the update check, and a preference that reads as an instruction', () => {
    const offered = (update: Parameters<typeof buildPaletteItems>[0]['update']): string[] =>
      buildPaletteItems(context({ update }))
        .filter((item) => item.kind === 'action')
        .map((item) => item.label)

    expect(offered(null)).toContain('Check for Updates')
    expect(offered(null)).toContain('Stop Checking for Updates Automatically')
    expect(offered(updateState({ automatic: false }))).toContain('Check for Updates Automatically')
  })

  it('shows the key that does the same thing', () => {
    const items = buildPaletteItems(context({ hintFor: (action) => (action === 'new-terminal' ? '⌘T' : '') }))

    expect(items.find((item) => item.kind === 'action' && item.id === 'new-terminal')?.hint).toBe('⌘T')
  })
})

describe('score', () => {
  it('finds letters in order and refuses letters that are not there', () => {
    expect(score('rank results', 'rr')).not.toBeNull()
    expect(score('rank results', 'rz')).toBeNull()
  })

  it('prefers the whole query together over the same letters scattered', () => {
    const together = score('login fix', 'login') as number
    const scattered = score('l o g i n something', 'login') as number
    expect(together).toBeGreaterThan(scattered)
  })

  it('prefers a match that starts a word', () => {
    expect(score('fix login', 'login') as number).toBeGreaterThan(score('relogin fixes', 'login') as number)
  })

  // The one loose match worth keeping, and the words have to be next to each
  // other: `nw` is the initials of "New worktree" and is not in "now here" at
  // all — the letters are, which is exactly what the old matcher went by.
  it('matches an initialism across consecutive words, and nothing looser', () => {
    expect(score('New worktree', 'nw')).not.toBeNull()
    expect(score('now here', 'nw')).toBeNull()
    expect(score('New terminal, worktree list', 'nw')).toBeNull()
  })

  it('is case-insensitive in both directions', () => {
    expect(score('Login Fix', 'login')).not.toBeNull()
    expect(score('login fix', 'LOGIN')).not.toBeNull()
  })

  it('matches everything when nothing has been typed', () => {
    expect(score('anything at all', '')).toBe(0)
  })
})

describe('filterPalette', () => {
  const items: PaletteItem[] = [
    { kind: 'worktree', id: 'w1', label: 'login fix', hint: 'task/login', detail: 'atlas', search: 'login fix' },
    {
      kind: 'worktree',
      id: 'w2',
      label: 'schema migration',
      hint: 'task/schema',
      detail: 'ledger',
      search: 'schema migration'
    },
    {
      kind: 'action',
      id: 'new-terminal',
      label: 'New Terminal',
      hint: '',
      detail: '',
      search: 'New Terminal shell'
    }
  ]

  it('keeps everything, in order, before anything is typed', () => {
    expect(filterPalette(items, '').map((item) => item.id)).toEqual(['w1', 'w2', 'new-terminal'])
  })

  it('drops what does not match at all', () => {
    expect(filterPalette(items, 'zzz')).toEqual([])
  })

  it('ranks the thing you meant first', () => {
    expect(filterPalette(items, 'login')[0]?.id).toBe('w1')
    expect(filterPalette(items, 'schema')[0]?.id).toBe('w2')
    expect(filterPalette(items, 'terminal')[0]?.id).toBe('new-terminal')
  })

  it('finds an action by a word that is not in its label', () => {
    expect(filterPalette(items, 'shell')[0]?.id).toBe('new-terminal')
  })

  it('ignores surrounding whitespace rather than failing to match on it', () => {
    expect(filterPalette(items, '  login  ')[0]?.id).toBe('w1')
  })
})

describe('moveSelection', () => {
  it('wraps at both ends', () => {
    expect(moveSelection(3, 2, 1)).toBe(0)
    expect(moveSelection(3, 0, -1)).toBe(2)
  })

  it('stays at zero when there is nothing to select', () => {
    expect(moveSelection(0, 0, 1)).toBe(0)
  })
})

describe('the CLI row', () => {
  const status = (overrides: Partial<CliStatus> = {}): CliStatus =>
    ({
      installable: true,
      packaged: true,
      platform: 'darwin',
      state: 'absent',
      destination: '/usr/local/bin/teamree',
      directory: '/usr/local/bin',
      source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
      bundle: '/Applications/teamree.app/Contents/Resources/cli/cli.js',
      resolved: null,
      dangling: false,
      impermanent: null,
      needsAdministrator: true,
      onPath: 'environment',
      askedAt: null,
      ...overrides
    }) as CliStatus

  const rowOf = (cli: CliStatus | null): PaletteItem | undefined =>
    buildPaletteItems(context({ cli })).find((item) => item.id === 'install-cli')

  it.each([
    ['absent', status()],
    ['broken', status({ state: 'elsewhere', dangling: true, resolved: '/gone/teamree' })],
    ['another copy', status({ state: 'elsewhere', dangling: false, resolved: '/other/teamree' })]
  ])('is Install Command Line Tool when the link is %s', (_, cli) => {
    expect(rowOf(cli)).toMatchObject({ label: 'Install Command Line Tool' })
    expect(rowOf(cli)).not.toHaveProperty('unavailable')
  })

  it('is left out once the link works', () => {
    expect(rowOf(status({ state: 'linked' }))).toHaveProperty('unavailable')
  })

  it('is reachable by the words somebody would type', () => {
    const row = rowOf(status())
    expect(row?.search).toContain('path')
    expect(row?.search).toContain('symlink')
  })
})

// ⌘K used to answer `push` with "Stop checking for updates automatically" and
// `commit` with "Fix the broken teamree command": the matcher took any
// subsequence of the typed letters, scattered anywhere through a row's label
// and keywords, and kept every row it did not outright refuse. A palette that
// answers with rows containing none of what was typed is one nobody trusts a
// second time.
describe('what the palette returns for what was typed', () => {
  const full = (): PaletteItem[] =>
    buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' })],
        activeWorktreeId: 'w1',
        agents: [agent('claude'), agent('codex')],
        update: updateState()
      })
    )

  const labels = (query: string): string[] => filterPalette(full(), query).map((item) => item.label)

  it.each([
    ['push', ['Push']],
    ['commit', ['Commit…']],
    ['clau', ['Start Claude Code Here']]
  ] as ReadonlyArray<readonly [string, string[]]>)('answers %s with only the rows that carry it', (query, expected) => {
    expect(labels(query)).toEqual(expected)
  })

  it('refuses a row that carries none of the query, however its letters fall', () => {
    expect(score('Stop Checking for Updates Automatically updates automatic quiet release notify', 'push')).toBeNull()
    expect(score('Fix the broken teamree command cli command line terminal install link symlink', 'commit')).toBeNull()
    expect(score('Appearance… theme colour color dark black contrast accent ground', 'clau')).toBeNull()
  })

  it('still ranks a contiguous match over one that starts no word', () => {
    expect(score('Push', 'push') as number).toBeGreaterThan(score('repushing', 'push') as number)
  })
})

// One table of commands, read by the menu bar and by the palette alike. The
// palette used to keep its own list, which is why it had no row for Push,
// Commit, Close Pane, Maximize Pane, either pane walk or either worktree walk —
// every one of them in the menu, none of them findable by typing its name.
describe('every command the menu has is a row in the palette', () => {
  const MENU_STATE = {
    consent: {},
    dialog: null,
    projects: [{ id: 'p1' }],
    worktrees: [{ id: 'w1', projectId: 'p1' }],
    activeWorktreeId: 'w1',
    layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf' as const, terminalId: 't1' }, focusedTerminalId: 't1' } },
    watches: [],
    focusedWatchId: null,
    statuses: {},
    pushing: false
  }

  it('offers each of them once, under the label the menu uses', () => {
    const items = buildPaletteItems(context())
    for (const entry of menuBarSpec(MENU_STATE as never)) {
      const rows = items.filter((item) => item.kind === 'action' && item.id === entry.command)
      expect(
        rows.map((row) => row.label),
        entry.command
      ).toEqual([entry.label])
    }
  })

  it('says Show or Hide for a panel as the menu does', () => {
    const panels = { sidebarVisible: false, rightPanelOpen: false }
    const items = buildPaletteItems(context(panels))
    for (const entry of menuBarSpec({ ...MENU_STATE, ...panels } as never)) {
      if (entry.command !== 'toggle-sidebar' && entry.command !== 'toggle-right-panel') continue
      expect(items.find((item) => item.id === entry.command)?.label).toBe(entry.label)
    }
    expect(items.find((item) => item.id === 'toggle-sidebar')?.label).toBe('Show Sidebar')
  })

  it('names its own rows as the menu names commands', () => {
    const labels = buildPaletteItems(context())
      .filter((item) => item.kind === 'action')
      .map((item) => item.label)
    expect(labels).toEqual(
      expect.arrayContaining(['Show Changes', 'Show Files', 'Add Project…', 'Clone Repository…', 'Check for Updates'])
    )
  })

  it('is findable by the words of that label', () => {
    const items = buildPaletteItems(context())
    for (const entry of menuBarSpec(MENU_STATE as never)) {
      const found = filterPalette(items, entry.label.replace('…', ''))
      expect(
        found.some((item) => item.id === entry.command),
        entry.label
      ).toBe(true)
    }
  })
})

describe('the files ⌘P lists', () => {
  const found = ['src/math.ts', 'src/lib/math/index.ts', 'docs/mathematics.md']

  it('lists recent files, latest first, before anything is typed', () => {
    expect(rankFiles([], ['b.ts', 'a.ts'], '', 50)).toEqual(['b.ts', 'a.ts'])
  })

  // Recency breaks ties; it never lifts a worse match over a better one.
  it('puts an exact file name above a recent file that only starts with the query', () => {
    const ranked = rankFiles(
      ['src/math.ts', 'packages/pkg0/src/auth7/mathHelper6.ts'],
      ['packages/pkg0/src/auth7/mathHelper6.ts'],
      'math',
      50
    )
    expect(ranked).toEqual(['src/math.ts', 'packages/pkg0/src/auth7/mathHelper6.ts'])
  })

  it('ranks by match quality, then recency within it, and lists each file once', () => {
    const ranked = rankFiles([...found, 'src/mathUtils.ts'], ['README.md', 'docs/mathematics.md'], 'math', 50)
    expect(ranked).toEqual(['src/math.ts', 'docs/mathematics.md', 'src/mathUtils.ts', 'src/lib/math/index.ts'])
  })

  it('narrows an answer to an earlier query to what is typed now', () => {
    expect(rankFiles(found, [], 'mathin', 50)).toEqual(['src/lib/math/index.ts'])
  })

  it('stops at the limit', () => {
    expect(rankFiles(found, ['src/math.ts'], 'ma', 2)).toHaveLength(2)
  })

  it('names a row by the file and hints its directory', () => {
    expect(fileItem('src/lib/math.ts')).toMatchObject({
      kind: 'file',
      id: 'src/lib/math.ts',
      label: 'math.ts',
      hint: 'src/lib'
    })
    expect(fileItem('README.md')).toMatchObject({ label: 'README.md', hint: '' })
  })
})

describe('what the palette offers for the worktree on screen', () => {
  const labels = (overrides: Partial<Parameters<typeof buildPaletteItems>[0]> = {}): string[] =>
    buildPaletteItems(context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1', ...overrides }))
      .filter((item) => item.kind === 'action')
      .map((item) => item.label)

  it('offers the sidebar row’s menu, every Open in target but Finder, which Reveal covers', () => {
    const offered = labels({ openIn: ['Cursor', 'Finder'] })
    expect(offered).toEqual(
      expect.arrayContaining([
        'Rename Worktree…',
        'Reveal in Finder',
        'Copy Path',
        'Copy Branch',
        'Open in Cursor',
        'Remove Worktree…'
      ])
    )
    expect(offered).not.toContain('Open in Finder')
  })

  it('offers a compare with each of the task’s other runs, and none for a lone worktree', () => {
    const task = 'Add a sub function to src/math.ts'
    const runs = ['claude', 'codex', 'claude 2'].map((agent, at) =>
      worktree({ id: `r${at}`, name: `Add a sub function to src/math.ts ${agent}`, branch: `sub-${at}`, task })
    )
    const items = buildPaletteItems(context({ worktrees: [...runs, worktree({ id: 'w1' })], activeWorktreeId: 'r0' }))
    const compares = items.filter((item) => item.kind === 'action' && item.id.startsWith('compare:'))
    expect(compares.map((item) => [item.id, item.label])).toEqual([
      ['compare:r1', 'Compare with codex'],
      ['compare:r2', 'Compare with claude 2']
    ])
    expect(filterPalette(items, 'compare')[0]?.label).toBe('Compare with codex')
    expect(labels().some((label) => label.startsWith('Compare with'))).toBe(false)
  })

  it('offers only removal for a checkout gone from disk, and nothing with no worktree open', () => {
    const missing = labels({ worktrees: [worktree({ id: 'w1', missing: true })] })
    expect(missing).toContain('Remove Worktree…')
    expect(missing).not.toContain('Rename Worktree…')
    expect(labels({ activeWorktreeId: null })).not.toContain('Remove Worktree…')
  })

  it('offers discard and unstage only for a focused file that has them', () => {
    expect(labels()).not.toContain('Discard File Changes…')
    const both = labels({ focusedChange: { path: 'src/a.ts', discardable: true, staged: true } })
    expect(both).toEqual(expect.arrayContaining(['Discard File Changes…', 'Unstage File']))
    const staged = labels({ focusedChange: { path: 'src/a.ts', discardable: false, staged: true } })
    expect(staged).not.toContain('Discard File Changes…')
  })

  it('offers the three modes and every preset, leaving out the ones on screen', () => {
    const items = buildPaletteItems(context({ appearance: { mode: 'dark', themeId: 'black' } }))
    const reason = (label: string): string | undefined => {
      const item = items.find((entry) => entry.label === label)
      return item?.kind === 'action' ? (item.unavailable ?? 'none') : undefined
    }
    expect(reason('Appearance: Light')).toBe('none')
    expect(reason('Appearance: Match System')).toBe('none')
    expect(reason('Appearance: Dark')).toBe('current')
    expect(reason('Theme: Paper')).toBe('none')
    expect(reason('Theme: Absolute Black')).toBe('current')
    const listed = filterPalette(items, '').map((item) => item.label)
    expect(listed).toContain('Appearance: Light')
    expect(listed).not.toContain('Appearance: Dark')
    expect(listed).not.toContain('Theme: Absolute Black')
  })

  it.each([
    ['rename', 'Rename Worktree…'],
    ['reveal', 'Reveal in Finder'],
    ['discard', 'Discard File Changes…'],
    ['open in', 'Open in Cursor'],
    ['appearance light', 'Appearance: Light'],
    ['dark', 'Appearance: Dark'],
    ['copy path', 'Copy Path']
  ])('answers %s with %s first', (query, label) => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1' })],
        activeWorktreeId: 'w1',
        openIn: ['Cursor'],
        focusedChange: { path: 'src/a.ts', discardable: true, staged: false }
      })
    )
    expect(filterPalette(items, query)[0]?.label).toBe(label)
  })
})

describe('a command that would do nothing now', () => {
  const items = (reasons: Partial<Record<string, string>> = {}): PaletteItem[] =>
    buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1' })],
        activeWorktreeId: 'w1',
        whyUnavailable: (action) => reasons[action] ?? null
      })
    )

  it('is left out before anything is typed', () => {
    const all = filterPalette(items({ 'new-worktree': 'no project' }), '')
    expect(all.some((item) => item.id === 'new-worktree')).toBe(false)
    expect(all.some((item) => item.id === 'new-terminal')).toBe(true)
  })

  it('is left out of a query that finds something that would run', () => {
    const found = filterPalette(items({ 'save-file': 'nothing unsaved' }), 'save')
    expect(found.map((item) => item.label)).toEqual(['Save All'])
  })

  it('shows, dimmed and with nothing after it, when it is all a query finds', () => {
    const found = filterPalette(items({ 'save-file': 'nothing unsaved', 'save-all': 'nothing unsaved' }), 'save')
    expect(found.map((item) => item.label)).toEqual(['Save', 'Save All'])
    expect(found.every((item) => item.kind === 'action' && item.unavailable !== undefined)).toBe(true)
    expect(found.map(trailing)).toEqual(['', ''])
  })

  // `Commit…` came first through the "message" in its hidden keywords.
  it('ranks a label match over a keyword match: sa finds Save first', () => {
    expect(filterPalette(items(), 'sa')[0]?.label).toBe('Save')
  })
})

describe('the first screen, before anything is typed', () => {
  const items = (): PaletteItem[] =>
    buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' }), worktree({ id: 'w2', name: 'schema' })],
        activeWorktreeId: 'w1',
        agents: [agent('claude')],
        whyUnavailable: (action) => (action === 'save-file' ? 'nothing unsaved' : null)
      })
    )

  it('lists worktrees, then the one on screen under its own name, then every other command', () => {
    const groups = paletteGroups(items(), [], 'login fix')
    expect(groups.map((group) => group.title)).toEqual(['Worktrees', 'login fix', 'Commands'])
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['w2', 'w1'])
    expect(groups[1]?.items.map((item) => item.label)).toEqual([
      'Start Claude Code Here',
      'Rename Worktree…',
      'Reveal in Finder',
      'Copy Path',
      'Copy Branch',
      'Remove Worktree…'
    ])
    // The header names the worktree once; its rows do not repeat it.
    expect(groups[1]?.items.map(trailing)).toEqual(['', '', '', '', '', ''])
    expect(groups[2]?.items.some((item) => item.id === 'new-terminal')).toBe(true)
  })

  it('leads with the commands last run from it, each listed once', () => {
    const groups = paletteGroups(items(), ['action:new-terminal', 'agent:claude', 'action:gone'], 'login fix')
    expect(groups[0]?.title).toBe('Recent')
    expect(groups[0]?.items.map(paletteKey)).toEqual(['action:new-terminal', 'agent:claude'])
    const rest = groups.slice(1).flatMap((group) => group.items.map(paletteKey))
    expect(rest).not.toContain('action:new-terminal')
    expect(rest).not.toContain('agent:claude')
  })

  it('leaves out what would do nothing, recent or not', () => {
    const groups = paletteGroups(items(), ['action:save-file'], 'login fix')
    const listed = groups.flatMap((group) => group.items.map((item) => item.label))
    expect(listed).not.toContain('Save')
    expect(groups[0]?.title).toBe('Worktrees')
  })

  it('has no group for the worktree on screen when none is', () => {
    const groups = paletteGroups(buildPaletteItems(context({ worktrees: [worktree({ id: 'w1' })] })), [], '')
    expect(groups.map((group) => group.title)).toEqual(['Worktrees', 'Commands'])
  })
})

describe('the commands last run from the palette', () => {
  it('keeps the latest first, once each, five at most', () => {
    let recent: string[] = []
    for (const key of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) recent = withRecent(recent, key)
    expect(recent).toEqual(['f', 'e', 'd', 'a', 'c'])
    expect(recent).toHaveLength(RECENT_KEPT)
  })

  it('survives a reload, and reads a corrupt entry as none', () => {
    const kept = new Map<string, string>()
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value)
    }
    writeStoredRecent(storage, ['action:new-terminal', 'agent:claude'])
    expect(readStoredRecent(storage)).toEqual(['action:new-terminal', 'agent:claude'])
    for (const [key] of kept) kept.set(key, '{"not":"a list"}')
    expect(readStoredRecent(storage)).toEqual([])
    expect(readStoredRecent(undefined)).toEqual([])
  })
})

describe('the one column after a label', () => {
  const items = buildPaletteItems(
    context({
      worktrees: [worktree({ id: 'w1', name: 'login fix' })],
      activeWorktreeId: 'w1',
      hintFor: (action) => (action === 'new-terminal' ? '⌘T' : action === 'save-file' ? '⌘S' : ''),
      whyUnavailable: (action) => (action === 'save-file' ? 'nothing unsaved' : null)
    })
  )
  const find = (id: string): PaletteItem => items.find((item) => item.id === id) as PaletteItem

  it('is the chord when there is one', () => {
    expect(trailing(find('new-terminal'))).toBe('⌘T')
  })

  it('is empty for a dimmed command', () => {
    expect(trailing(find('save-file'))).toBe('')
  })

  it('is the project and state for a worktree', () => {
    expect(trailing(find('w1'))).toBe('atlas · current')
  })

  it('is the directory for a file', () => {
    expect(trailing(fileItem('src/lib/math.ts'))).toBe('src/lib')
  })
})
