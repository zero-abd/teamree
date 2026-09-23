import { describe, expect, it } from 'vitest'
import type { CliStatus, InstalledAgent, Project, UpdateState, Worktree } from '@shared/entities'
import { menuBarSpec } from '../menu/menuBar'
import { buildPaletteItems, filterPalette, moveSelection, score, type PaletteItem } from './paletteModel'

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
  it('offers every worktree but the one already open', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'here' }), worktree({ id: 'elsewhere' })],
        activeWorktreeId: 'here'
      })
    )

    const ids = items.filter((item) => item.kind === 'worktree').map((item) => item.id)
    expect(ids).toEqual(['elsewhere'])
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
    expect(agents.map((item) => item.label)).toEqual(['Start claude in this worktree', 'Start codex in this worktree'])
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
  it('says the agent opens a pane in the worktree already on screen', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'w1', name: 'login fix' })],
        activeWorktreeId: 'w1',
        agents: [agent('claude')]
      })
    )

    const [found] = items.filter((item) => item.kind === 'agent')
    expect(found?.hint).toBe('login fix')
    expect(found?.detail).toBe('Opens a pane here')
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

    expect(offered(null)).toContain('Check for updates')
    expect(offered(null)).toContain('Stop checking for updates automatically')
    expect(offered(updateState({ automatic: false }))).toContain('Check for updates automatically')
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
      label: 'New terminal',
      hint: '',
      detail: 'Action',
      search: 'New terminal shell'
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

// "Put teamree on my PATH" is the right offer to somebody who has no teamree on
// their PATH, and the wrong one to everybody else this row is shown to. The
// state that matters is a link that exists and leads to a deleted build: the
// shell finds it, follows it, and says the command does not exist, and the app
// knew that and offered to do what had already been done.
describe('the CLI row is named after what is actually wrong', () => {
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

  const labelOf = (cli: CliStatus | null): string | undefined =>
    buildPaletteItems(context({ cli })).find((item) => item.id === 'install-cli')?.label

  it('offers to make the link when there is none', () => {
    expect(labelOf(status())).toBe('Put teamree on my PATH')
  })

  it('offers to repair it when the link is there and leads nowhere', () => {
    expect(labelOf(status({ state: 'elsewhere', dangling: true, resolved: '/gone/teamree' }))).toBe(
      'Fix the broken teamree command'
    )
  })

  it('says which copy when the link works and drives another one', () => {
    expect(labelOf(status({ state: 'elsewhere', dangling: false, resolved: '/other/teamree' }))).toBe(
      'Point teamree at this app'
    )
  })

  // The label moves; what somebody types to find it must not.
  it('is still reachable by the words somebody would type', () => {
    const broken = buildPaletteItems(context({ cli: status({ state: 'elsewhere', dangling: true }) }))
    const row = broken.find((item) => item.id === 'install-cli')
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
    ['clau', ['Start claude in this worktree']]
  ] as ReadonlyArray<readonly [string, string[]]>)('answers %s with only the rows that carry it', (query, expected) => {
    expect(labels(query)).toEqual(expected)
  })

  it('refuses a row that carries none of the query, however its letters fall', () => {
    expect(score('Stop checking for updates automatically updates automatic quiet release notify', 'push')).toBeNull()
    expect(score('Fix the broken teamree command cli command line terminal install link symlink', 'commit')).toBeNull()
    expect(score('Appearance… theme colour color dark black contrast accent ground', 'clau')).toBeNull()
  })

  it('still ranks a contiguous match over one that starts no word', () => {
    expect(score('Push', 'push') as number).toBeGreaterThan(score('repushing', 'push') as number)
  })
})

// One table of commands, read by the menu bar and by the palette alike. The
// palette used to keep its own list, which is why it had no row for Push,
// Commit, Close pane, Maximize pane, either pane walk or either worktree walk —
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
