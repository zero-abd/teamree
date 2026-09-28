import { describe, expect, it } from 'vitest'
import type { CliStatus, InstalledAgent, Project, Terminal, UpdateState, Worktree } from '@shared/entities'
import { formatInvitation } from '@shared/invitation'
import type { SharedNoteSummary } from '@shared/sharedNote'
import { menuBarSpec } from '../menu/menuBar'
import {
  buildPaletteItems,
  fileItem,
  filterPalette,
  moveSelection,
  paletteGroups,
  paletteKey,
  queryGroups,
  rankFiles,
  readStoredRecent,
  RECENT_KEPT,
  score,
  trailing,
  withRecent,
  writeStoredRecent,
  type PaletteGroup,
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
  it('names a worktree as the sidebar does, hinting the branch unless it is the name', () => {
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
      [task, 'add-a-subtract-function-to-claude'],
      ['perf', '']
    ])
    // The glyph tells sibling runs apart on the row; typing the agent's name still finds it.
    expect(rows[0]).toMatchObject({ agent: 'claude' })
    expect(rows[0]?.search).toContain('add-a-subtract-function-to-claude')
    expect(rows[0]?.search).toContain('Claude Code')
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

  it('offers the diff toggles by what they do next', () => {
    const find = (options?: { wrap: boolean; hideWhitespace: boolean }, id = 'toggle-diff-wrap'): string | undefined =>
      buildPaletteItems(context(options === undefined ? {} : { diffOptions: options })).find((item) => item.id === id)
        ?.label
    expect(find()).toBe('Wrap Diff Lines')
    expect(find({ wrap: true, hideWhitespace: false })).toBe('Unwrap Diff Lines')
    expect(find(undefined, 'toggle-diff-whitespace')).toBe('Hide Whitespace Changes')
    expect(find({ wrap: false, hideWhitespace: true }, 'toggle-diff-whitespace')).toBe('Show Whitespace Changes')
  })

  it('offers the markdown source toggle by what it does next', () => {
    const find = (markdownSource?: boolean): string | undefined =>
      buildPaletteItems(context(markdownSource === undefined ? {} : { markdownSource })).find(
        (item) => item.id === 'toggle-markdown-source'
      )?.label
    expect(find()).toBe('Show Markdown Source')
    expect(find(true)).toBe('Show Markdown Page')
  })

  it('names its own rows as the menu names commands', () => {
    const labels = buildPaletteItems(context())
      .filter((item) => item.kind === 'action')
      .map((item) => item.label)
    expect(labels).toEqual(
      expect.arrayContaining(['Show Changes', 'Show Files', 'Open Folder…', 'Clone Repository…', 'Check for Updates'])
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
        'Remove Worktree from teamree',
        'Delete Worktree…'
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
      ['compare:r1', 'Compare with Codex'],
      ['compare:r2', 'Compare with Claude Code 2']
    ])
    expect(filterPalette(items, 'compare')[0]?.label).toBe('Compare with Codex')
    expect(labels().some((label) => label.startsWith('Compare with'))).toBe(false)
  })

  it('offers Run: Dev and Run: Tests with their commands, and Show, Restart and Stop while one runs', () => {
    const runs = [
      { kind: 'dev' as const, command: 'npm run dev' },
      { kind: 'test' as const, command: 'npm test' }
    ]
    const items = buildPaletteItems(
      context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1', runs })
    ).filter((item) => item.kind === 'action' && /^(run|restart-run|stop-run):/.test(item.id))
    expect(items.map((item) => [item.id, item.label, item.hint])).toEqual([
      ['run:dev', 'Run: Dev', 'npm run dev'],
      ['run:test', 'Run: Tests', 'npm test']
    ])
    expect(
      filterPalette(
        buildPaletteItems(context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1', runs })),
        'run dev'
      )[0]?.id
    ).toBe('run:dev')

    const running = [{ kind: 'dev' as const, command: 'npm run dev', state: 'running' as const }]
    expect(labels({ runs: running })).toEqual(expect.arrayContaining(['Show Dev', 'Restart Dev', 'Stop Dev']))
    expect(labels().some((label) => label.startsWith('Run:'))).toBe(false)
  })

  it('offers Keep This Run… beside the compares, and none for a lone worktree', () => {
    const task = 'Add a sub function to src/math.ts'
    const runs = ['claude', 'codex'].map((agent, at) =>
      worktree({ id: `r${at}`, name: `Add a sub function to src/math.ts ${agent}`, branch: `sub-${at}`, task })
    )
    expect(labels({ worktrees: runs, activeWorktreeId: 'r0' })).toContain('Keep This Run…')
    expect(labels()).not.toContain('Keep This Run…')
  })

  it('offers the landing the Changes header offers, and nothing before there is one', () => {
    expect(labels({ land: { kind: 'create-pr' } })).toContain('Create Pull Request…')
    expect(labels({ land: { kind: 'open-pr', number: 12, url: 'https://x/pull/12' } })).toContain(
      'Open Pull Request #12'
    )
    expect(labels({ land: { kind: 'merge', into: 'main' } })).toContain('Merge into main…')
    const none = labels({ land: null })
    // Check Out Pull Request… is the project's, not the worktree's landing.
    expect(none.some((label) => /(Create|Open) Pull Request|Merge into/.test(label))).toBe(false)
  })

  it('offers Resume Conversation… when Claude Code or Codex is installed', () => {
    expect(labels()).not.toContain('Resume Conversation…')
    expect(labels({ agents: [agent('gemini')] })).not.toContain('Resume Conversation…')
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1' })],
        activeWorktreeId: 'w1',
        agents: [agent('codex')],
        resumable: true
      })
    )
    const row = items.find((item) => item.label === 'Resume Conversation…')
    expect(row).toMatchObject({ kind: 'action', id: 'resume-conversation', here: true })
    expect(row).not.toHaveProperty('unavailable')
    expect(filterPalette(items, 'resume')[0]?.label).toBe('Resume Conversation…')
    expect(labels({ agents: [agent('claude')], worktrees: [worktree({ id: 'w1', missing: true })] })).not.toContain(
      'Resume Conversation…'
    )
  })

  // Dimmed rather than hidden, so typing it still says why it would do nothing.
  it('dims Resume Conversation… in a worktree with no past conversations', () => {
    const items = buildPaletteItems(
      context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1', agents: [agent('claude')] })
    )
    expect(items.find((item) => item.label === 'Resume Conversation…')).toMatchObject({
      unavailable: 'no past conversations'
    })
    expect(filterPalette(items, '').map((item) => item.label)).not.toContain('Resume Conversation…')
    expect(filterPalette(items, 'resume conv').map((item) => item.label)).toContain('Resume Conversation…')
  })

  it('offers only removal for a checkout gone from disk, and nothing with no worktree open', () => {
    const missing = labels({ worktrees: [worktree({ id: 'w1', missing: true })] })
    expect(missing).toEqual(expect.arrayContaining(['Remove Worktree from teamree', 'Delete Worktree…']))
    expect(missing).not.toContain('Rename Worktree…')
    expect(labels({ activeWorktreeId: null })).not.toContain('Delete Worktree…')
  })

  it('offers Update from the base only when the worktree is behind it', () => {
    expect(labels()).not.toContain('Update from main')
    const behind = buildPaletteItems(
      context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1', updateFrom: 'main' })
    )
    const row = behind.find((item) => item.label === 'Update from main')
    expect(row).toMatchObject({ kind: 'action', id: 'update-worktree', here: true })
    expect(filterPalette(behind, 'rebase')[0]?.label).toBe('Update from main')
  })

  it('offers Resolve Conflicts, Continue Update and Abort Update while an update is stopped', () => {
    const stopped = (conflicted: number) =>
      buildPaletteItems(
        context({
          worktrees: [worktree({ id: 'w1' })],
          activeWorktreeId: 'w1',
          statuses: {
            w1: {
              worktreeId: 'w1',
              branch: 'task/w1',
              ahead: 1,
              behind: 1,
              staged: 0,
              unstaged: 0,
              untracked: 0,
              conflicted,
              operation: 'rebase',
              readAt: 0
            }
          }
        })
      )
    const rows = stopped(2).filter((item) => item.kind === 'action' && item.here === true)
    expect(rows.map((item) => item.label)).toEqual(
      expect.arrayContaining(['Resolve Conflicts', 'Continue Update', 'Abort Update'])
    )
    expect(rows.find((item) => item.label === 'Continue Update')).toMatchObject({ unavailable: '2 conflicted' })
    expect(stopped(0).find((item) => item.label === 'Continue Update')?.kind === 'action').toBe(true)
    expect(
      (stopped(0).find((item) => item.label === 'Continue Update') as { unavailable?: string }).unavailable
    ).toBeUndefined()
    expect(labels()).not.toContain('Continue Update')
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
        resumable: true,
        whyUnavailable: (action) => (action === 'save-file' ? 'nothing unsaved' : null)
      })
    )

  it('lists worktrees, then the one on screen under its own name, then every other command', () => {
    const groups = paletteGroups(items(), [], 'login fix')
    expect(groups.map((group) => group.title)).toEqual(['Worktrees', 'login fix', 'Commands'])
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['w2', 'w1'])
    expect(groups[1]?.items.map((item) => item.label)).toEqual([
      'Start Claude Code Here',
      'Resume Conversation…',
      'Rename Worktree…',
      'Reveal in Finder',
      'Copy Path',
      'Copy Branch',
      'Remove Worktree from teamree',
      'Delete Worktree…'
    ])
    // The header names the worktree once; its rows do not repeat it.
    expect(groups[1]?.items.map(trailing)).toEqual(['', '', '', '', '', '', '', ''])
    expect(groups[2]?.items.some((item) => item.id === 'new-terminal')).toBe(true)
  })

  it('heads Commands with the commands last run from it, each listed once', () => {
    const groups = paletteGroups(items(), ['action:new-terminal', 'agent:claude', 'action:gone'], 'login fix')
    const commands = groups.find((group) => group.title === 'Commands')
    expect(commands?.items.slice(0, 2).map(paletteKey)).toEqual(['action:new-terminal', 'agent:claude'])
    const all = groups.flatMap((group) => group.items.map(paletteKey))
    expect(all.filter((key) => key === 'action:new-terminal' || key === 'agent:claude')).toHaveLength(2)
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

describe('opening a branch as it is', () => {
  it('offers Open Branch… and Check Out Pull Request…, reached by the words people use', () => {
    const items = buildPaletteItems(context())
    const branch = items.find((item) => item.id === 'open-branch')
    const pull = items.find((item) => item.id === 'open-pull-request')
    expect(branch?.label).toBe('Open Branch…')
    expect(pull?.label).toBe('Check Out Pull Request…')
    expect(branch?.search).toMatch(/checkout/)
    expect(pull?.search).toMatch(/review pr/)
  })

  it('says there is no project to open one in', () => {
    const items = buildPaletteItems(context({ projects: [] }))
    expect(items.find((item) => item.id === 'open-branch')).toMatchObject({ unavailable: 'no project' })
  })
})

describe('Clean Up Merged in the palette', () => {
  it('has one row per project, dimmed where nothing has merged', () => {
    const items = buildPaletteItems(context({ merged: new Set(['p2']) }))
    const rows = items.filter((item) => item.id.startsWith('clean-up:'))

    expect(
      rows.map((item) => [item.id, item.label, item.hint, item.kind === 'action' ? item.unavailable : null])
    ).toEqual([
      ['clean-up:p1', 'Clean Up Merged…', 'atlas', 'nothing merged'],
      ['clean-up:p2', 'Clean Up Merged…', 'ledger', undefined]
    ])
    expect(filterPalette(items, 'clean up').map((item) => item.id)).toEqual(['clean-up:p2'])
  })
})

describe('Push main in the palette', () => {
  it('has a row for each project whose main is ahead of origin', () => {
    const items = buildPaletteItems(
      context({ unpushed: [{ projectId: 'p2', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 }] })
    )
    const rows = items.filter((item) => item.id.startsWith('push-base:'))

    expect(rows.map((item) => [item.id, item.label, item.hint])).toEqual([['push-base:p2', 'Push main', 'ledger · ↑2']])
    expect(filterPalette(items, 'push main').map((item) => item.id)).toContain('push-base:p2')
  })
})

describe('Fetch Now in the palette', () => {
  it('has a row for each project, saying how old its base is', () => {
    const projects = [
      { id: 'p1', name: 'atlas', path: '/a', baseRef: 'origin/main' },
      { id: 'p2', name: 'ledger', path: '/l', baseRef: 'origin/main', fetch: { failure: 'auth' as const } }
    ]
    const items = buildPaletteItems(context({ projects }))
    const rows = items.filter((item) => item.id.startsWith('fetch:'))

    expect(rows.map((item) => [item.id, item.label, item.hint])).toEqual([
      ['fetch:p1', 'Fetch Now', 'atlas · origin/main'],
      ['fetch:p2', 'Fetch Now', 'ledger · sign-in failed']
    ])
    expect(filterPalette(items, 'fetch ledger').map((item) => item.id)[0]).toBe('fetch:p2')
  })
})

describe('Teamwork and shared notes in the palette', () => {
  const note = (shareId: string, over: Partial<SharedNoteSummary> = {}): SharedNoteSummary => ({
    shareId,
    projectId: 'p2',
    handle: 'ana',
    publicKey: 'k',
    noteId: 'NOTES.md',
    title: 'Search API plan',
    sentAt: 0,
    receivedAt: Date.now() - 5 * 60_000,
    seen: false,
    bytes: 10,
    ...over
  })

  it('has a Teamwork row per project, whether or not it has a task, with its unread notes as the hint', () => {
    const items = buildPaletteItems(context({ sharedNotes: [note('s1'), note('s2', { read: true })] }))
    const rows = items.filter((item) => item.id.startsWith('teamwork:'))
    expect(rows.map((item) => [item.id, item.label, item.hint])).toEqual([
      ['teamwork:p1', 'Teamwork', 'atlas'],
      ['teamwork:p2', 'Teamwork', 'ledger · 1 unread']
    ])
    expect(filterPalette(items, 'teamwork ledger')[0]?.id).toBe('teamwork:p2')
  })

  it('lists each shared note, newest first, found by title or sender', () => {
    const items = buildPaletteItems(
      context({ sharedNotes: [note('s1', { title: 'Old', receivedAt: 0, read: true }), note('s2')] })
    )
    const rows = items.filter((item) => item.id.startsWith('shared-note:'))
    expect(rows.map((item) => [item.id, item.label, item.hint])).toEqual([
      ['shared-note:s2', 'Shared Note: Search API plan', 'ana · 5m ago · unread'],
      ['shared-note:s1', 'Shared Note: Old', expect.stringMatching(/^ana · /)]
    ])
    expect(filterPalette(items, 'search api')[0]?.id).toBe('shared-note:s2')
    expect(filterPalette(items, 'ana').map((item) => item.id)).toEqual(
      expect.arrayContaining(['shared-note:s1', 'shared-note:s2'])
    )
  })
})

describe('landing from the palette', () => {
  const found = (query: string, overrides: Partial<Parameters<typeof buildPaletteItems>[0]> = {}): PaletteItem[] =>
    filterPalette(
      buildPaletteItems(
        context({ worktrees: [worktree({ id: 'w1' })], activeWorktreeId: 'w1', merged: new Set(), ...overrides })
      ),
      query
    )
  const reason = (item: PaletteItem | undefined): string | undefined =>
    item?.kind === 'action' ? item.unavailable : undefined

  it.each([
    ['merge', { kind: 'merge', into: 'main' }, 'Merge into main…'],
    ['merge', { kind: 'merge', into: 'Rework auth', parent: true }, 'Merge into Parent…'],
    ['land', { kind: 'merge', into: 'main' }, 'Merge into main…'],
    ['pull request', { kind: 'create-pr' }, 'Create Pull Request…'],
    ['create pr', { kind: 'create-pr', uncommitted: 2 }, 'Commit & Create Pull Request…'],
    ['merge', { kind: 'merge', into: 'main', uncommitted: 2 }, 'Commit & Merge into main…']
  ] as const)('answers %s with the land on screen first', (query, land, label) => {
    const [first] = found(query, { land })
    expect(first?.label).toBe(label)
    expect(reason(first)).toBeUndefined()
  })

  it('counts what Commit & Merge would commit after its name', () => {
    const [first] = found('merge', { land: { kind: 'merge', into: 'main', uncommitted: 2 } })
    expect(first?.hint).toBe('2 uncommitted')
  })

  it('puts the worktree’s own merge before a project’s Clean Up Merged on a tie', () => {
    const rows = found('merge', { land: { kind: 'merge', into: 'main', uncommitted: 2 }, merged: new Set(['p1']) })
    expect(rows.map((item) => item.label)).toEqual(['Commit & Merge into main…', 'Clean Up Merged…'])
  })

  it('shows a blocked land dimmed with its reason, even when a runnable row matches too', () => {
    const merge = found('merge', { land: { kind: 'merge', into: 'main', blocked: '1 conflicted' }, updateFrom: 'main' })
    expect(merge.map((item) => item.label)).toEqual(['Update from main', 'Merge into main…'])
    expect(reason(merge[1])).toBe('1 conflicted')

    const pr = found('pull request', { land: { kind: 'create-pr', blocked: '1 conflicted' } })
    expect(pr.map((item) => item.label)).toEqual(['Check Out Pull Request…', 'Create Pull Request…'])
    expect(reason(pr[1])).toBe('1 conflicted')
  })

  it('names Push Publish Branch for a branch that tracks nothing yet, in the menu bar too', () => {
    const statuses = { w1: { upstream: null, ahead: 1 } }
    expect(found('publish', { statuses })[0]?.label).toBe('Publish Branch')
    expect(found('push', { statuses: { w1: { upstream: 'origin/task/w1', ahead: 1 } } })[0]?.label).toBe('Push')
  })
})

describe('starting a task from an issue', () => {
  it('offers New Task from Issue…, reached by the words people use', () => {
    const item = buildPaletteItems(context()).find((entry) => entry.id === 'new-task-from-issue')
    expect(item?.label).toBe('New Task from Issue…')
    expect(item?.search).toMatch(/github/)
    expect(item).not.toHaveProperty('unavailable')
  })

  it('says there is no project to start one in', () => {
    const items = buildPaletteItems(context({ projects: [] }))
    expect(items.find((item) => item.id === 'new-task-from-issue')).toMatchObject({ unavailable: 'no project' })
  })
})

describe('showing decisions', () => {
  it('offers Show Decisions, reached by claims and notes too', () => {
    const item = buildPaletteItems(context()).find((entry) => entry.id === 'show-decisions')
    expect(item?.label).toBe('Show Decisions')
    expect(item?.search).toMatch(/claims/)
    expect(item).not.toHaveProperty('unavailable')
  })

  it('says there is no project to show', () => {
    const items = buildPaletteItems(context({ projects: [] }))
    expect(items.find((item) => item.id === 'show-decisions')).toMatchObject({ unavailable: 'no project' })
  })
})

describe('an invitation pasted into the palette', () => {
  const invitation = { origin: 'git@github.com:ana/ledger.git', project: 'ledger', from: 'ana' }
  const none = buildPaletteItems(context({ projects: [], whyUnavailable: () => 'no project' }))

  it('offers to join from either form of the link, with no project and ahead of anything else', () => {
    for (const link of [formatInvitation(invitation), formatInvitation(invitation, 'page')]) {
      const [group] = queryGroups(none, `  come join: ${link} `, [])
      expect(group?.items.map((item) => [item.id, item.label])).toEqual([
        [`join:come join: ${link}`, 'Join ledger from ana']
      ])
    }
  })

  it('offers nothing to join for text that is not an invitation', () => {
    expect(queryGroups(none, 'teamree://join?v=1&project=ledger', [])).toEqual([])
  })

  it('offers Join a Team… to paste into, with no project too', () => {
    const items = buildPaletteItems(context({ projects: [] }))
    expect(filterPalette(items, 'join')[0]).toMatchObject({ id: 'join-team', label: 'Join a Team…' })
    expect(filterPalette(items, 'invitation')[0]).toMatchObject({ id: 'join-team' })
  })
})

describe('a query that finds nothing to run', () => {
  const items = (overrides: Partial<Parameters<typeof buildPaletteItems>[0]> = {}): PaletteItem[] =>
    buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' })],
        activeWorktreeId: 'w1',
        hintFor: (action) => (action === 'new-worktree' ? '⌘N' : ''),
        ...overrides
      })
    )
  const shown = (groups: PaletteGroup[]): [string | null, string[]][] =>
    groups.map((group) => [group.title, group.items.map((item) => item.label)])

  it('offers a new task with the query as its text, then Open Branch narrowed to it', () => {
    const [group] = queryGroups(items(), '  rate limits ', [])
    expect(group?.items.map((item) => [item.id, item.label, trailing(item)])).toEqual([
      ['new-task:rate limits', 'New Task: “rate limits”', '⌘N'],
      ['open-branch:rate limits', 'Open Branch: “rate limits”', '']
    ])
  })

  it('keeps what the query named, dimmed, above them', () => {
    const dimmed = items({ whyUnavailable: (action) => (action === 'save-all' ? 'nothing unsaved' : null) })
    expect(shown(queryGroups(dimmed, 'save all', []))).toEqual([
      ['Commands', ['Save All', 'New Task: “save all”', 'Open Branch: “save all”']]
    ])
  })

  it('adds nothing while a row would run, a file matched, or the files are still being searched', () => {
    expect(shown(queryGroups(items(), 'login', []))).toEqual([['Worktrees', ['login fix']]])
    expect(shown(queryGroups(items(), 'zzz', [fileItem('src/zzz.ts')]))).toEqual([['Files', ['zzz.ts']]])
    expect(shown(queryGroups(items(), 'zzz', null))).toEqual([])
  })

  it('offers neither with no project to start in or open from', () => {
    const none = items({ projects: [], worktrees: [], activeWorktreeId: null, whyUnavailable: () => 'no project' })
    expect(shown(queryGroups(none, 'zzz', []))).toEqual([])
  })

  it('leaves the order of a query that matches as it was within each group', () => {
    const all = items({ worktrees: [worktree({ id: 'w1' }), worktree({ id: 'w2', name: 'new tests' })] })
    for (const query of ['new', 'split', 'w2', 'nt']) {
      const found = filterPalette(all, query)
      expect(queryGroups(all, query, []).flatMap((group) => group.items)).toEqual(
        [...new Set(found.map(kindTitle))].flatMap((title) => found.filter((item) => kindTitle(item) === title))
      )
    }
  })
})

describe('a typed query, grouped', () => {
  const kinds = buildPaletteItems(
    context({
      worktrees: [worktree({ id: 'w1', name: 'payment retries' }), worktree({ id: 'w2', name: 'webhook payload' })],
      activeWorktreeId: 'w1',
      hintFor: (action) => (action === 'new-worktree' ? '⌘N' : '')
    })
  )
  const titles = (groups: PaletteGroup[]): (string | null)[] => groups.map((group) => group.title)

  it('heads each kind, the group holding the best match first, files after', () => {
    const groups = queryGroups(kinds, 'pay', [fileItem('src/pay/charge.ts')])
    expect(titles(groups)).toEqual(['Worktrees', 'Files'])
    expect(groups[0]?.items.map((item) => item.label)).toEqual(['payment retries', 'webhook payload'])
    const commands = queryGroups(kinds, 'copy', [])
    expect(titles(commands)).toEqual(['Commands'])
  })

  it('keeps the best match first, so Return still takes it', () => {
    for (const query of ['pay', 'new', 'split', 'copy branch']) {
      expect(queryGroups(kinds, query, [])[0]?.items[0]).toBe(filterPalette(kinds, query)[0])
    }
  })
})

const kindTitle = (item: PaletteItem): string =>
  item.kind === 'worktree' ? 'Worktrees' : item.kind === 'pane' ? 'Panes' : item.kind === 'file' ? 'Files' : 'Commands'

describe('a worktree row’s state', () => {
  const terminal = (overrides: Partial<Terminal> & { id: string; worktreeId: string }): Terminal => ({
    title: 'zsh',
    cwd: '/checkouts',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...overrides
  })
  const items = buildPaletteItems(
    context({
      worktrees: [
        worktree({ id: 'busy' }),
        worktree({ id: 'asks' }),
        worktree({ id: 'broke' }),
        worktree({ id: 'shell' }),
        worktree({ id: 'bare' }),
        worktree({ id: 'making', state: 'creating' })
      ],
      terminals: [
        terminal({ id: 't1', worktreeId: 'busy', agent: 'claude', busy: true }),
        terminal({ id: 't2', worktreeId: 'asks', agent: 'claude', titleSays: 'waiting' }),
        terminal({ id: 't3', worktreeId: 'broke', agent: 'codex', running: false, exitCode: 1 }),
        terminal({ id: 't4', worktreeId: 'shell' }),
        terminal({ id: 't5', worktreeId: 'making', agent: 'claude', busy: true })
      ]
    })
  )
  const worktreeRow = (id: string): PaletteItem | undefined => items.find((item) => item.id === id)

  it('carries the sidebar’s dot, and says working, asking or failed after the project', () => {
    expect(
      ['busy', 'asks', 'broke', 'shell', 'bare'].map((id) => {
        const item = worktreeRow(id)
        return [id, item?.kind === 'worktree' ? item.tone : 'none', item && trailing(item)]
      })
    ).toEqual([
      ['busy', 'working', 'atlas · working'],
      ['asks', 'waiting', 'atlas · asking'],
      ['broke', 'failed', 'atlas · failed'],
      ['shell', 'idle', 'atlas'],
      ['bare', undefined, 'atlas']
    ])
  })

  it('draws no dot for a worktree still being made', () => {
    const making = worktreeRow('making')
    expect(making?.kind === 'worktree' ? making.tone : 'none').toBeUndefined()
    expect(making && trailing(making)).toBe('atlas · creating')
  })
})

describe('the right panel’s rows say what they would do now', () => {
  const label = (id: string, overrides: Partial<Parameters<typeof buildPaletteItems>[0]>): PaletteItem | undefined =>
    buildPaletteItems(context(overrides)).find((item) => item.id === id)

  it('reads Hide Changes while the Changes tab is showing', () => {
    expect(label('toggle-changes', { rightPanelOpen: true, rightPanelTab: 'changes' })?.label).toBe('Hide Changes')
    expect(label('toggle-changes', { rightPanelOpen: false, rightPanelTab: 'changes' })?.label).toBe('Show Changes')
    expect(label('toggle-changes', { rightPanelOpen: true, rightPanelTab: 'files' })?.label).toBe('Show Changes')
  })

  it('dims Show Files while the Files tab is showing', () => {
    expect(label('show-files', { rightPanelOpen: true, rightPanelTab: 'files' })).toMatchObject({
      unavailable: 'shown'
    })
    expect(label('show-files', { rightPanelOpen: false, rightPanelTab: 'files' })).not.toHaveProperty('unavailable')
  })
})

describe('opening one setting from the palette', () => {
  const settingRows = (): PaletteItem[] =>
    buildPaletteItems(context()).filter((item) => item.kind === 'action' && item.id.startsWith('setting:'))

  it('offers a row per setting, named once however many sections carry it', () => {
    const labels = settingRows().map((item) => item.label)
    expect(labels).toContain('Open Setting: Worktrees in')
    expect(labels).toContain('Open Setting: Branch prefix')
    expect(labels).toContain('Open Setting: Scrollback lines')
    expect(new Set(labels).size).toBe(labels.length)
    expect(settingRows().find((item) => item.label === 'Open Setting: Worktrees in')).toMatchObject({
      id: 'setting:Worktrees in',
      hint: 'General'
    })
  })

  it('is found by what a setting is about, and stays out of the list before anything is typed', () => {
    const items = buildPaletteItems(context())
    expect(filterPalette(items, 'worktree folder')[0]?.label).toBe('Open Setting: Worktrees in')
    expect(filterPalette(items, 'branch prefix')[0]?.label).toBe('Open Setting: Branch prefix')
    const shown = paletteGroups(items, [], 'here').flatMap((group) => group.items)
    expect(shown.some((item) => item.id.startsWith('setting:'))).toBe(false)
  })
})

describe('where you have been', () => {
  const MINUTE = 60_000
  const NOW = 100 * MINUTE
  const worktrees = [
    worktree({ id: 'a', name: 'checkout flow' }),
    worktree({ id: 'b', name: 'pagination', projectId: 'p2' }),
    worktree({ id: 'c', name: 'db pool', projectId: 'p2' }),
    worktree({ id: 'd', name: 'faq' })
  ]
  const terminal = (overrides: Partial<Terminal> & { id: string; worktreeId: string }): Terminal => ({
    title: 'zsh',
    cwd: '/',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...overrides
  })
  const terminals = [
    terminal({ id: 't-shell', worktreeId: 'a' }),
    terminal({ id: 't-claude', worktreeId: 'b', agent: 'claude', lastOutputAt: NOW - 4 * MINUTE }),
    terminal({ id: 't-codex', worktreeId: 'd', agent: 'codex', lastOutputAt: NOW - 9 * MINUTE }),
    terminal({ id: 't-dev', worktreeId: 'a', title: 'npm run dev', lastOutputAt: NOW - 30 * MINUTE }),
    terminal({ id: 't-here', worktreeId: 'c', agent: 'claude', lastOutputAt: NOW })
  ]
  // Visited a, then b, then c, which is on screen.
  const items = (): PaletteItem[] =>
    buildPaletteItems(
      context({
        worktrees,
        activeWorktreeId: 'c',
        terminals,
        visited: { a: NOW - 5 * MINUTE, b: NOW - 2 * MINUTE, c: NOW },
        // Looked at more lately than it printed.
        paneSeenAt: { 't-codex': NOW - MINUTE },
        focusedPaneId: 't-here',
        now: NOW
      })
    )

  it('opens on the worktree before this one, so ⌘K Enter goes back, then the others by visit, with how long ago', () => {
    const groups = paletteGroups(items(), [], 'db pool')
    expect(groups[0]?.title).toBe('Recent')
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['b', 'a'])
    expect(groups[0]?.items.map((item) => (item.kind === 'worktree' ? item.age : null))).toEqual(['2m', '5m'])
    const listed = groups.flatMap((group) => group.items.map(paletteKey))
    expect(listed.filter((key) => key === 'worktree:b')).toHaveLength(1)
  })

  it('then the agent and command panes of every worktree, the latest active first', () => {
    const groups = paletteGroups(items(), [], 'db pool')
    expect(groups.map((group) => group.title).slice(0, 3)).toEqual(['Recent', 'Panes', 'Worktrees'])
    const panes = groups[1]?.items ?? []
    expect(panes.map((item) => item.label)).toEqual([
      'Codex · faq',
      'Claude Code · pagination',
      'npm run dev · checkout flow'
    ])
    expect(panes.map((item) => (item.kind === 'pane' ? item.age : null))).toEqual(['1m', '4m', '30m'])
    expect(panes.map(trailing)).toEqual(['atlas', 'ledger', 'atlas'])
  })

  it('names a pane called after its worktree once', () => {
    const named = buildPaletteItems(
      context({
        worktrees,
        activeWorktreeId: 'c',
        terminals: [terminal({ id: 't-task', worktreeId: 'd', agent: 'claude', label: 'faq' })]
      })
    )
    expect(named.find((item) => item.id === 't-task')?.label).toBe('faq')
  })

  it('then the rest in sidebar order, with nothing visited yet', () => {
    const groups = paletteGroups(buildPaletteItems(context({ worktrees, activeWorktreeId: 'c' })), [], 'db pool')
    expect(groups[0]?.title).toBe('Worktrees')
  })

  it('finds a running pane by its agent and by its worktree', () => {
    const claude = filterPalette(items(), 'claude')
    expect(claude.some((item) => item.kind === 'pane' && item.id === 't-claude')).toBe(true)
    expect(filterPalette(items(), 'pagination').map(paletteKey)).toContain('pane:t-claude')
    expect(filterPalette(items(), 'npm run').map(paletteKey)[0]).toBe('pane:t-dev')
  })
})

// After a quit with a fleet of agents, each one had to be resumed by hand.
describe('Resume Stopped Agents', () => {
  const ended = (id: string, extra: Partial<Terminal> = {}): Terminal => ({
    id,
    worktreeId: 'w1',
    title: 'claude',
    cwd: '/r',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: false,
    busy: false,
    lastOutputAt: 0,
    agent: 'claude',
    exitCode: 1,
    ...extra
  })
  const row = (terminals: Terminal[]) =>
    buildPaletteItems(context({ terminals })).find(
      (item) => item.kind === 'action' && item.id === 'resume-stopped-agents'
    )

  it('is offered with a count when agents can pick their conversations back up, and not otherwise', () => {
    expect(row([ended('a', { resumable: true }), ended('b', { resumable: true }), ended('c')])).toMatchObject({
      label: 'Resume Stopped Agents',
      hint: '2'
    })
    expect(row([ended('c'), ended('d', { restored: 'stopped', stoppedFor: 'no-conversation' })])).toBeUndefined()
  })
})
