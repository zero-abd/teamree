// A stand-in runtime that answers the whole method catalogue from memory, so
// the interface is demonstrable — splits, background worktree creation,
// failures, live terminal output — before the real transport exists. It is
// deliberately the only place in the renderer that fabricates data.

import type {
  Layout,
  PaneNode,
  Project,
  StartPoint,
  StartPointList,
  Terminal,
  Worktree,
  WorktreeChange,
  WorktreeStatus
} from '@shared/entities'
import type { MethodName, ParamsOf, ResultOf, TerminalEvent, WorkspaceEvent } from '@shared/methods'
import { leaf, splitPane } from '../panes/paneLayout'
import type { ConnectionState, RuntimeClient, Subscription } from './RuntimeClientContract'

const CREATE_MS = 2600
const LATENCY_MS = 45

let counter = 0
const nextId = (prefix: string): string => `${prefix}_${(++counter).toString(36).padStart(4, '0')}`

const sgr = (code: string, text: string): string => `\u001b[${code}m${text}\u001b[0m`
const dim = (text: string): string => sgr('38;5;244', text)
const accent = (text: string): string => sgr('38;5;147', text)
const good = (text: string): string => sgr('38;5;114', text)
const warn = (text: string): string => sgr('38;5;179', text)

type FakeTerminal = {
  record: Terminal
  buffer: string
  line: string
  listeners: Set<(event: TerminalEvent) => void>
}

/**
 * Paths the seeded changes are drawn from, cycled so the same worktree always
 * shows the same files. Invented, but invented once.
 */
const SEEDED_PATHS = [
  'src/search/rankResults.ts',
  'src/search/index.ts',
  'src/search/rankResults.test.ts',
  'src/shell/StatusBar.tsx',
  'src/styles/tokens.css',
  'docs/search.md',
  'scripts/reindex.mjs',
  'src/server/handlers.ts'
]

/**
 * Changed paths made up to match a worktree's counters, so the list and the
 * chips above it never contradict each other in the demo.
 */
function seededChanges(status: WorktreeStatus): WorktreeChange[] {
  const changes: WorktreeChange[] = []
  let next = 0
  const take = (): string => SEEDED_PATHS[next++ % SEEDED_PATHS.length] as string

  for (let index = 0; index < status.conflicted; index += 1) {
    changes.push({ path: take(), kind: 'conflicted', staged: false, unstaged: true })
  }
  for (let index = 0; index < status.staged; index += 1) {
    changes.push({ path: take(), kind: index === 0 ? 'added' : 'modified', staged: true, unstaged: false })
  }
  for (let index = 0; index < status.unstaged; index += 1) {
    changes.push({ path: take(), kind: 'modified', staged: false, unstaged: true })
  }
  for (let index = 0; index < status.untracked; index += 1) {
    changes.push({ path: take(), kind: 'untracked', staged: false, unstaged: true })
  }
  return changes
}

/** A small believable patch, so the diff pane has something to render. */
function seededPatch(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 3f8a1c2..9b21e40 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -14,7 +14,9 @@',
    ' export function rankResults(hits: Hit[], query: Query): Hit[] {',
    '-  return hits.sort((left, right) => right.score - left.score)',
    '+  const weighted = hits.map((hit) => ({ ...hit, score: hit.score * recency(hit) }))',
    '+  // Ties went to whichever the index happened to return first, which is',
    '+  // not stable between runs.',
    '+  return weighted.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))',
    ' }',
    ''
  ].join('\n')
}

export function createSeededRuntimeClient(): RuntimeClient {
  const projects = new Map<string, Project>()
  const worktrees = new Map<string, Worktree>()
  const statuses = new Map<string, WorktreeStatus>()
  const terminals = new Map<string, FakeTerminal>()
  const layouts = new Map<string, Layout>()

  let connection: ConnectionState = { phase: 'connecting', detail: 'Starting runtime' }
  const connectionListeners = new Set<(state: ConnectionState) => void>()

  // The demo announces its own changes exactly as the real runtime does, so the
  // browser path exercises the same subscribe-and-refetch code rather than a
  // second, quieter one that could rot unnoticed. Delivery is deferred by a
  // turn because a handler is still mid-call when it announces: the caller must
  // have its result before a refetch goes looking for what it changed.
  const workspaceWatchers = new Set<(event: WorkspaceEvent) => void>()
  const announce = (...events: WorkspaceEvent[]): void => {
    setTimeout(() => {
      for (const event of events) {
        for (const watcher of [...workspaceWatchers]) watcher(event)
      }
    }, 0)
  }

  const setConnection = (state: ConnectionState): void => {
    connection = state
    for (const listener of connectionListeners) listener(state)
  }

  // The real client flips to ready once the handshake lands; mirror that shape
  // so the status bar has the same states to animate through.
  setTimeout(() => setConnection({ phase: 'ready' }), 420)

  const emit = (terminal: FakeTerminal, event: TerminalEvent): void => {
    if (event.type === 'data') terminal.buffer = (terminal.buffer + event.data).slice(-64000)
    for (const listener of terminal.listeners) listener(event)
  }

  const prompt = (terminal: FakeTerminal): string => {
    const worktree = worktrees.get(terminal.record.worktreeId)
    return `${accent(worktree?.branch ?? 'teamree')} ${dim('❯')} `
  }

  const spawn = (worktreeId: string, title: string, banner: string[]): Terminal => {
    const worktree = worktrees.get(worktreeId)
    const record: Terminal = {
      id: nextId('term'),
      worktreeId,
      title,
      cwd: worktree?.path ?? '~',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      running: true
    }
    const terminal: FakeTerminal = { record, buffer: '', line: '', listeners: new Set() }
    terminals.set(record.id, terminal)
    terminal.buffer = `${banner.join('\r\n')}\r\n${prompt(terminal)}`
    return record
  }

  const seedProject = (name: string, path: string, baseRef: string): Project => {
    const project: Project = { id: nextId('proj'), name, path, baseRef }
    projects.set(project.id, project)
    return project
  }

  const seedWorktree = (
    project: Project,
    name: string,
    branch: string,
    state: Worktree['state'],
    extra?: Partial<Worktree>
  ): Worktree => {
    const worktree: Worktree = {
      id: nextId('wt'),
      projectId: project.id,
      name,
      branch,
      path: `${project.path}/.worktrees/${branch.replace(/\//g, '-')}`,
      startedFrom: project.baseRef,
      state,
      createdAt: Date.now() - 1000 * 60 * 90,
      ...extra
    }
    worktrees.set(worktree.id, worktree)
    return worktree
  }

  const seedStatus = (worktree: Worktree, partial: Omit<WorktreeStatus, 'worktreeId' | 'branch' | 'readAt'>): void => {
    statuses.set(worktree.id, { worktreeId: worktree.id, branch: worktree.branch, readAt: Date.now(), ...partial })
  }

  // --- seed -----------------------------------------------------------------

  const atlas = seedProject('atlas', '/Users/dev/code/atlas', 'origin/main')
  const ledger = seedProject('ledger-api', '/Users/dev/code/ledger-api', 'origin/trunk')

  const search = seedWorktree(atlas, 'incremental search index', 'task/incremental-search', 'ready')
  const themes = seedWorktree(atlas, 'theme tokens pass', 'task/theme-tokens', 'ready')
  const flaky = seedWorktree(atlas, 'quarantine flaky suite', 'task/quarantine-flaky', 'creating')
  const migration = seedWorktree(ledger, 'ledger schema migration', 'task/schema-migration', 'ready')
  seedWorktree(ledger, 'retry webhook delivery', 'task/webhook-retry', 'failed', {
    error: "fatal: invalid reference 'origin/trunk'; fetch the remote and try again"
  })

  seedStatus(search, { ahead: 3, behind: 0, staged: 2, unstaged: 4, untracked: 1, conflicted: 0 })
  seedStatus(themes, { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
  seedStatus(migration, { ahead: 1, behind: 12, staged: 0, unstaged: 3, untracked: 0, conflicted: 2 })

  const searchShell = spawn(search.id, 'zsh', [
    dim('teamree · worktree ready in 1.9s'),
    `${good('✓')} branch ${accent(search.branch)} tracking ${dim('origin/main')}`
  ])
  const searchAgent = spawn(search.id, 'agent', [
    accent('▌ agent session'),
    dim('reading src/index/tokenizer.ts …'),
    `${good('✓')} 42 tests passed in 3.4s`,
    dim('waiting for instructions')
  ])
  const searchLogs = spawn(search.id, 'dev server', [
    dim('$ npm run dev'),
    `${good('ready')} http://localhost:5173`,
    dim('watching 318 modules')
  ])
  const themeShell = spawn(themes.id, 'zsh', [dim('teamree · nothing to report')])
  const migrationShell = spawn(migration.id, 'zsh', [
    `${warn('!')} 2 conflicted paths after rebase`,
    dim('db/schema.sql, db/migrations/0042_accounts.sql')
  ])

  layouts.set(search.id, {
    worktreeId: search.id,
    focusedTerminalId: searchAgent.id,
    root: {
      kind: 'split',
      direction: 'row',
      sizes: [0.56, 0.44],
      children: [
        leaf(searchShell.id),
        {
          kind: 'split',
          direction: 'column',
          sizes: [0.62, 0.38],
          children: [leaf(searchAgent.id), leaf(searchLogs.id)]
        }
      ]
    }
  })
  layouts.set(themes.id, { worktreeId: themes.id, focusedTerminalId: themeShell.id, root: leaf(themeShell.id) })
  layouts.set(migration.id, {
    worktreeId: migration.id,
    focusedTerminalId: migrationShell.id,
    root: leaf(migrationShell.id)
  })

  // The demo's one live stream, so an idle window still shows the app breathing.
  const logLines = [
    `${dim('12:04:18')} ${good('GET')} /api/index/status ${dim('200 · 4ms')}`,
    `${dim('12:04:21')} ${accent('hmr')} update src/index/tokenizer.ts`,
    `${dim('12:04:27')} ${good('GET')} /api/index/search?q=pane ${dim('200 · 11ms')}`,
    `${dim('12:04:33')} ${warn('warn')} reindex queue depth 4`
  ]
  let logCursor = 0
  setInterval(() => {
    const terminal = terminals.get(searchLogs.id)
    if (!terminal?.record.running) return
    emit(terminal, { type: 'data', data: `${logLines[logCursor % logLines.length]}\r\n` })
    logCursor++
  }, 3200)

  // Background worktree creation, including the failure path, so the sidebar's
  // creating and failed states are reachable without a backend.
  const finishCreation = (worktreeId: string, shouldFail: boolean): void => {
    setTimeout(() => {
      const worktree = worktrees.get(worktreeId)
      if (!worktree || worktree.state !== 'creating') return
      if (shouldFail) {
        worktrees.set(worktreeId, {
          ...worktree,
          state: 'failed',
          error: `fatal: '${worktree.branch}' is already checked out at ${worktree.path}`
        })
        announce({ type: 'worktrees' })
        return
      }
      const ready: Worktree = { ...worktree, state: 'ready' }
      worktrees.set(worktreeId, ready)
      seedStatus(ready, { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
      const shell = spawn(worktreeId, 'zsh', [
        dim('teamree · worktree ready'),
        `${good('✓')} ${accent(ready.branch)} from ${dim(ready.startedFrom)}`
      ])
      layouts.set(worktreeId, { worktreeId, focusedTerminalId: shell.id, root: leaf(shell.id) })
      announce({ type: 'worktrees' }, { type: 'terminals' }, { type: 'layout', worktreeId })
    }, CREATE_MS)
  }

  finishCreation(flaky.id, false)

  // --- method dispatch ------------------------------------------------------

  const handlers: { [M in MethodName]: (params: ParamsOf<M>) => ResultOf<M> } = {
    'status.get': () => ({
      version: '0.0.1-demo',
      endpoint: '/tmp/teamree.sock',
      pid: 4242,
      platform: 'darwin',
      startedAt: Date.now() - 90000
    }),

    'project.list': () => [...projects.values()],
    'project.add': ({ path, name }) => {
      const project: Project = {
        id: nextId('proj'),
        name: name ?? path.split('/').filter(Boolean).pop() ?? path,
        path,
        baseRef: 'origin/main'
      }
      projects.set(project.id, project)
      announce({ type: 'projects' })
      return project
    },
    'project.remove': ({ projectId }) => {
      projects.delete(projectId)
      for (const worktree of worktrees.values()) {
        if (worktree.projectId === projectId) worktrees.delete(worktree.id)
      }
      announce({ type: 'projects' }, { type: 'worktrees' })
      return { removed: true }
    },

    'worktree.list': ({ projectId }) =>
      [...worktrees.values()].filter((worktree) => !projectId || worktree.projectId === projectId),
    'worktree.get': ({ worktreeId }) => required(worktrees.get(worktreeId), 'worktree'),
    'worktree.create': ({ projectId, name, startedFrom, branch }) => {
      const project = required(projects.get(projectId), 'project')
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '') || 'untitled'
      const worktree: Worktree = {
        id: nextId('wt'),
        projectId,
        name,
        branch: branch ?? `task/${slug}`,
        path: `${project.path}/.worktrees/${slug}`,
        startedFrom: startedFrom ?? project.baseRef,
        state: 'creating',
        createdAt: Date.now()
      }
      worktrees.set(worktree.id, worktree)
      announce({ type: 'worktrees' })
      // A task named "fail…" is the demo's reproducible failure path.
      finishCreation(worktree.id, /fail/i.test(name))
      return worktree
    },
    'worktree.remove': ({ worktreeId }) => {
      worktrees.delete(worktreeId)
      statuses.delete(worktreeId)
      layouts.delete(worktreeId)
      for (const terminal of terminals.values()) {
        if (terminal.record.worktreeId === worktreeId) terminals.delete(terminal.record.id)
      }
      announce({ type: 'worktrees' }, { type: 'terminals' })
      return { removed: true }
    },
    'worktree.startPoints': ({ projectId, limit }) => {
      const project = required(projects.get(projectId), 'project')
      // Branches this window has already made are start points in their own right.
      const fromWorktrees = [...worktrees.values()]
        .filter((row) => row.projectId === projectId)
        .map((row) => ({
          ref: row.branch,
          kind: 'localBranch' as const,
          minutesAgo: (Date.now() - row.createdAt) / 60_000
        }))
      const seeds = SEEDED_REFS[project.name] ?? REFS_FOR_A_NEW_PROJECT
      const rows = [...seeds, ...fromWorktrees].map(startPointRow)
      return capStartPoints(project.baseRef, rows, limit ?? SEEDED_LIMITS[project.name] ?? 200)
    },
    'worktree.status': ({ worktreeId }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const existing = statuses.get(worktreeId)
      const status: WorktreeStatus = existing
        ? { ...existing, readAt: Date.now() }
        : {
            worktreeId,
            branch: worktree.branch,
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            readAt: Date.now()
          }
      statuses.set(worktreeId, status)
      return status
    },
    'worktree.changes': ({ worktreeId, limit }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const all = status ? seededChanges(status) : []
      const cap = limit ?? 500
      return {
        worktreeId: worktree.id,
        changes: all.slice(0, cap),
        total: all.length,
        limit: cap,
        truncated: all.length > cap,
        readAt: Date.now()
      }
    },
    'worktree.commit': ({ worktreeId, message, paths }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const changes = status ? seededChanges(status) : []
      const captured = paths && paths.length > 0 ? paths : changes.filter((c) => c.staged).map((c) => c.path)
      // The seeded workspace moves with it: what was committed is no longer a
      // pending change, so the chips settle the way they would for real.
      if (status) {
        seedStatus(worktree, {
          ahead: status.ahead + 1,
          behind: status.behind,
          staged: 0,
          unstaged: status.unstaged,
          untracked: status.untracked,
          conflicted: status.conflicted
        })
      }
      announce({ type: 'worktrees' })
      const sha = nextId('sha').replace(/[^a-z0-9]/g, '')
      return {
        worktreeId,
        sha,
        shortSha: sha.slice(0, 7),
        message,
        paths: [...captured].sort(),
        committedAt: Date.now()
      }
    },
    'worktree.push': ({ worktreeId, remote }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const target = remote ?? 'origin'
      // Nothing ahead means nothing to send, which is the outcome worth seeing
      // in a demo as much as the other one.
      const alreadyUpToDate = (status?.ahead ?? 0) === 0
      if (status && !alreadyUpToDate) {
        seedStatus(worktree, { ...status, ahead: 0 })
        announce({ type: 'worktrees' })
      }
      return {
        worktreeId,
        remote: target,
        branch: worktree.branch,
        alreadyUpToDate,
        upstream: `${target}/${worktree.branch}`,
        setUpstream: false,
        uncommitted: (status?.staged ?? 0) + (status?.unstaged ?? 0),
        pushedAt: Date.now()
      }
    },
    'worktree.mergePreview': ({ worktreeId }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const project = projects.get(worktree.projectId)
      const status = statuses.get(worktreeId)
      // Seeded to match the chips: a worktree carrying conflicts is exactly the
      // one that would not go in cleanly.
      const conflicted = (status?.conflicted ?? 0) > 0
      return {
        worktreeId,
        baseRef: project?.baseRef ?? 'origin/main',
        state: conflicted ? 'conflicts' : (status?.ahead ?? 0) === 0 ? 'nothingToMerge' : 'clean',
        ahead: status?.ahead ?? 0,
        conflicts: conflicted
          ? seededChanges(status as WorktreeStatus)
              .slice(0, status?.conflicted ?? 0)
              .map((change) => change.path)
          : [],
        readAt: Date.now()
      }
    },
    'worktree.diff': ({ worktreeId, path, staged }) => {
      const worktree = required(worktrees.get(worktreeId), 'worktree')
      const status = statuses.get(worktreeId)
      const changes = status ? seededChanges(status) : []
      const wanted = path === undefined ? changes.filter((change) => change.staged === (staged ?? false)) : [{ path }]
      return {
        worktreeId: worktree.id,
        ...(path === undefined ? {} : { path }),
        staged: staged ?? false,
        patch: wanted.map((change) => seededPatch(change.path)).join('\n'),
        truncated: false,
        readAt: Date.now()
      }
    },

    'agent.list': () => [
      { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
      { kind: 'codex', command: 'codex', binary: '/usr/local/bin/codex' }
    ],
    'terminal.list': ({ worktreeId }) =>
      [...terminals.values()]
        .map((terminal) => terminal.record)
        .filter((record) => !worktreeId || record.worktreeId === worktreeId),
    'terminal.create': ({ worktreeId, cols, rows }) => {
      const record = spawn(worktreeId, 'zsh', [dim('teamree · new session')])
      const terminal = required(terminals.get(record.id), 'terminal')
      terminal.record = { ...record, cols: cols ?? record.cols, rows: rows ?? record.rows }
      const layout = layouts.get(worktreeId)
      if (!layout?.root) {
        layouts.set(worktreeId, { worktreeId, root: leaf(record.id), focusedTerminalId: record.id })
      } else {
        const root = layout.root
        const share = root.kind === 'split' && root.direction === 'row' ? 1 / (root.children.length + 1) : 0.5
        layouts.set(worktreeId, {
          worktreeId,
          focusedTerminalId: record.id,
          root:
            root.kind === 'split' && root.direction === 'row'
              ? {
                  ...root,
                  children: [...root.children, leaf(record.id)],
                  sizes: [...root.sizes.map((size) => size * (1 - share)), share]
                }
              : { kind: 'split', direction: 'row', children: [root, leaf(record.id)], sizes: [0.5, 0.5] }
        })
      }
      announce({ type: 'terminals' }, { type: 'layout', worktreeId })
      return terminal.record
    },
    'terminal.write': ({ terminalId, data }) => {
      const terminal = required(terminals.get(terminalId), 'terminal')
      echo(terminal, data, emit, prompt)
      return { written: true }
    },
    'terminal.resize': ({ terminalId, cols, rows }) => {
      const terminal = required(terminals.get(terminalId), 'terminal')
      terminal.record = { ...terminal.record, cols, rows }
      return terminal.record
    },
    'terminal.close': ({ terminalId }) => {
      const terminal = terminals.get(terminalId)
      if (terminal) {
        terminal.record = { ...terminal.record, running: false, exitCode: 0 }
        emit(terminal, { type: 'exit', exitCode: 0 })
        terminals.delete(terminalId)
        announce(
          { type: 'terminalExited', terminalId, exitCode: 0 },
          { type: 'terminals' },
          { type: 'layout', worktreeId: terminal.record.worktreeId }
        )
      }
      return { closed: true }
    },
    'terminal.read': ({ terminalId, tailBytes }) => {
      const terminal = required(terminals.get(terminalId), 'terminal')
      return { data: tailBytes ? terminal.buffer.slice(-tailBytes) : terminal.buffer }
    },
    'terminal.subscribe': ({ terminalId }) => {
      required(terminals.get(terminalId), 'terminal')
      return { subscription: nextId('sub') }
    },
    'terminal.split': ({ terminalId, direction }) => {
      const source = required(terminals.get(terminalId), 'terminal')
      const worktreeId = source.record.worktreeId
      const record = spawn(worktreeId, 'zsh', [dim('teamree · split pane')])
      const current = layouts.get(worktreeId)
      const layout: Layout = {
        worktreeId,
        root: splitPane(current?.root ?? null, terminalId, direction, record.id),
        focusedTerminalId: record.id
      }
      layouts.set(worktreeId, layout)
      announce({ type: 'terminals' }, { type: 'layout', worktreeId })
      return { terminal: record, layout }
    },

    'layout.get': ({ worktreeId }) => layouts.get(worktreeId) ?? { worktreeId, root: null, focusedTerminalId: null },
    'layout.set': ({ worktreeId, root, focusedTerminalId }) => {
      const layout: Layout = { worktreeId, root: (root as PaneNode | null) ?? null, focusedTerminalId }
      layouts.set(worktreeId, layout)
      announce({ type: 'layout', worktreeId })
      return layout
    },

    // The renderer watches through `watchWorkspace` below rather than this
    // method, which exists only to keep the catalogue complete.
    'workspace.subscribe': () => ({ subscription: nextId('sub') }),

    unsubscribe: () => ({ unsubscribed: true })
  }

  return {
    get connection() {
      return connection
    },
    onConnectionChange(listener) {
      connectionListeners.add(listener)
      return () => {
        connectionListeners.delete(listener)
      }
    },
    async call(method, params) {
      await sleep(LATENCY_MS)
      const handler = handlers[method] as (input: unknown) => unknown
      return handler(params) as ResultOf<typeof method>
    },
    watchWorkspace(onEvent) {
      workspaceWatchers.add(onEvent)
      let closed = false
      return {
        close: () => {
          if (closed) return
          closed = true
          workspaceWatchers.delete(onEvent)
        }
      }
    },
    async subscribeTerminal(terminalId, onEvent) {
      await sleep(LATENCY_MS)
      const terminal = terminals.get(terminalId)
      if (!terminal) return { close: () => {} }
      terminal.listeners.add(onEvent)
      let closed = false
      const subscription: Subscription = {
        close: () => {
          if (closed) return
          closed = true
          terminal.listeners.delete(onEvent)
        }
      }
      return subscription
    }
  }
}

/** Line-disciplined echo: enough of a shell for the layout to feel alive. */
function echo(
  terminal: FakeTerminal,
  data: string,
  emit: (terminal: FakeTerminal, event: TerminalEvent) => void,
  prompt: (terminal: FakeTerminal) => string
): void {
  for (const char of data) {
    if (char === '\r') {
      const command = terminal.line.trim()
      terminal.line = ''
      emit(terminal, { type: 'data', data: '\r\n' })
      if (command) {
        emit(terminal, { type: 'data', data: `${dim(`demo runtime: '${command}' was not run`)}\r\n` })
      }
      emit(terminal, { type: 'data', data: prompt(terminal) })
    } else if (char === '\u007f' || char === '\b') {
      if (terminal.line.length > 0) {
        terminal.line = terminal.line.slice(0, -1)
        emit(terminal, { type: 'data', data: '\b \b' })
      }
    } else if (char >= ' ') {
      terminal.line += char
      emit(terminal, { type: 'data', data: char })
    }
  }
}

// --- start points ------------------------------------------------------------
//
// A repository's refs are the one thing the demo cannot derive from its own
// worktrees, so they are seeded outright, remotes and tags included: a stand-in
// that only ever showed local branches would leave the picker's other sections
// and its truncation notice unexercised in the browser.

type SeedRef = { ref: string; kind: StartPoint['kind']; minutesAgo: number; current?: boolean }

const SEEDED_REFS: Record<string, SeedRef[]> = {
  atlas: [
    { ref: 'main', kind: 'localBranch', minutesAgo: 26, current: true },
    { ref: 'legacy/import-pipeline', kind: 'localBranch', minutesAgo: 60 * 24 * 96 },
    { ref: 'origin/main', kind: 'remoteBranch', minutesAgo: 24 },
    { ref: 'origin/next', kind: 'remoteBranch', minutesAgo: 60 * 7 },
    { ref: 'origin/release-4.2', kind: 'remoteBranch', minutesAgo: 60 * 31 },
    { ref: 'origin/hotfix/token-leak', kind: 'remoteBranch', minutesAgo: 60 * 3 },
    { ref: 'upstream/main', kind: 'remoteBranch', minutesAgo: 60 * 19 },
    { ref: 'v4.2.0', kind: 'tag', minutesAgo: 60 * 24 * 5 },
    { ref: 'v4.1.3', kind: 'tag', minutesAgo: 60 * 24 * 41 },
    { ref: 'v4.0.0', kind: 'tag', minutesAgo: 60 * 24 * 190 }
  ],
  'ledger-api': [
    { ref: 'trunk', kind: 'localBranch', minutesAgo: 52, current: true },
    { ref: 'origin/trunk', kind: 'remoteBranch', minutesAgo: 41 },
    { ref: 'v2.9.0', kind: 'tag', minutesAgo: 60 * 24 * 12 },
    { ref: 'v2.8.4', kind: 'tag', minutesAgo: 60 * 24 * 33 },
    // A wall of stale integration branches, which is what a long-lived
    // repository looks like and what makes the cap worth showing.
    ...Array.from({ length: 46 }, (_, index) => ({
      ref: `origin/integration/batch-${String(index + 1).padStart(3, '0')}`,
      kind: 'remoteBranch' as const,
      minutesAgo: 60 * 24 * (index + 2)
    }))
  ]
}

/** Projects whose listing is deliberately capped, to exercise `truncated`. */
const SEEDED_LIMITS: Record<string, number> = { 'ledger-api': 14 }

const REFS_FOR_A_NEW_PROJECT: SeedRef[] = [
  { ref: 'main', kind: 'localBranch', minutesAgo: 12, current: true },
  { ref: 'origin/main', kind: 'remoteBranch', minutesAgo: 12 }
]

function startPointRow(seed: SeedRef): StartPoint {
  const sha = fakeSha(seed.ref)
  const namespace = seed.kind === 'tag' ? 'tags' : seed.kind === 'remoteBranch' ? 'remotes' : 'heads'
  return {
    ref: seed.ref,
    kind: seed.kind,
    sha,
    shortSha: sha.slice(0, 7),
    refName: `refs/${namespace}/${seed.ref}`,
    isBase: false,
    isCurrent: seed.current === true,
    updatedAt: Math.round((Date.now() - seed.minutesAgo * 60_000) / 1000)
  }
}

/** Marks the base ref, orders exactly as the runtime does, then applies the cap. */
function capStartPoints(baseRef: string, rows: StartPoint[], limit: number): StartPointList {
  const rank = (option: StartPoint): number => {
    if (option.isBase) return 0
    if (option.isCurrent) return 1
    return { head: 2, localBranch: 3, remoteBranch: 4, tag: 5, commit: 6 }[option.kind]
  }
  const marked = rows.map((row) => (row.ref === baseRef ? { ...row, isBase: true } : row))
  marked.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || a.ref.localeCompare(b.ref))
  return { baseRef, options: marked.slice(0, limit), total: marked.length, limit, truncated: marked.length > limit }
}

/** Stable digits per ref name, so a row keeps its sha across refetches. */
function fakeSha(ref: string): string {
  let hash = 0x81_1c_9d_c5
  for (const character of ref) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01_00_01_93) >>> 0
  let sha = ''
  let state = hash
  while (sha.length < 40) {
    state = Math.imul(state ^ (state >>> 15), 0x25_45_f4_91) >>> 0
    sha += state.toString(16).padStart(8, '0')
  }
  return sha.slice(0, 40)
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`not_found: ${what}`)
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
