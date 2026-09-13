import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import type { TerminalRecord } from '../terminals/session-restore'
import { DEFAULT_APPEARANCE } from '../../shared/theme'
import { describeStoreProblem, WorkspaceStore, type StoreProblem } from './workspaceStore'

const project: Project = { id: 'p1', name: 'teamree', path: '/repos/teamree', baseRef: 'origin/main' }

function worktree(id: string, projectId = 'p1'): Worktree {
  return {
    id,
    projectId,
    name: id,
    branch: `feature/${id}`,
    path: `/repos/teamree-${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1700000000000
  }
}

describe('workspace store', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-store-'))
    filePath = join(directory, 'state', 'workspace.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('starts empty when the file does not exist', async () => {
    const store = await WorkspaceStore.open(filePath)
    expect(store.snapshot()).toEqual({ projects: [], worktrees: [], layouts: [], terminals: [] })
  })

  it('writes through a temp file and leaves none behind', async () => {
    const store = await WorkspaceStore.open(filePath)
    store.putProject(project)
    store.putWorktree(worktree('w1'))
    store.putLayout({ worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' })
    await store.flush()

    const written = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(written.projects).toEqual([project])
    expect(written.layouts).toEqual([
      { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' }
    ])
    expect((await readdir(join(directory, 'state'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('coalesces a burst of mutations into a durable final state', async () => {
    const store = await WorkspaceStore.open(filePath)
    store.putProject(project)
    for (let index = 0; index < 25; index += 1) store.putWorktree(worktree(`w${index}`))
    await store.flush()

    const reopened = await WorkspaceStore.open(filePath)
    expect(reopened.listWorktrees('p1')).toHaveLength(25)
    expect(reopened.getProject('p1')).toEqual(project)
  })

  it('starts empty rather than throwing on a corrupt file', async () => {
    const corruptPath = join(directory, 'workspace.json')
    await writeFile(corruptPath, '{"projects": [{"id": "p1"', 'utf8')

    const store = await WorkspaceStore.open(corruptPath, { onProblem: () => {} })

    expect(store.snapshot()).toEqual({ projects: [], worktrees: [], layouts: [], terminals: [] })
    store.putProject(project)
    await store.flush()
    expect(JSON.parse(await readFile(corruptPath, 'utf8'))).toMatchObject({ projects: [project] })
  })

  // An empty sidebar is what a first launch looks like, so the one thing that
  // distinguishes it from somebody's whole workspace failing to load has to be
  // said rather than left for them to work out.
  it('says a file could not be read instead of opening as if there were none', async () => {
    const path = join(directory, 'workspace.json')
    await writeFile(path, '{"projects": [{"id": "p1"', 'utf8')
    const problems: StoreProblem[] = []

    const unreadable = await WorkspaceStore.open(path, { onProblem: (problem) => problems.push(problem) })
    const missing = await WorkspaceStore.open(join(directory, 'never-written.json'), { onProblem: () => {} })

    expect(unreadable.unreadable).toContain('JSON')
    expect(problems).toEqual([{ kind: 'unreadable', filePath: path, reason: unreadable.unreadable }])
    expect(missing.unreadable).toBeUndefined()
  })

  // Crash-atomic writes make this unlikely, not impossible — a disk that filled
  // mid-write, a filesystem that did not honour the rename, a file from an
  // older build. Whatever it holds is somebody's projects, worktrees and agent
  // session ids, and this process is the only thing between them and a fresh
  // empty file written over the top.
  it('keeps the bytes of a file it could not read before writing over them', async () => {
    const path = join(directory, 'workspace.json')
    const original = '{"projects": [{"id": "p1"'
    await writeFile(path, original, 'utf8')
    const problems: StoreProblem[] = []

    const store = await WorkspaceStore.open(path, {
      onProblem: (problem) => problems.push(problem),
      now: () => Date.parse('2026-01-02T03:04:05.678Z')
    })
    store.putProject(project)
    await store.flush()

    const kept = join(directory, 'workspace.json.unreadable-2026-01-02T03-04-05-678Z')
    expect(await readFile(kept, 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ projects: [project] })
    expect(problems.map((problem) => problem.kind)).toEqual(['unreadable', 'keptAside'])
    // Said once: the file has been dealt with and is now an ordinary one.
    store.putWorktree(worktree('w1'))
    await store.flush()
    expect(problems).toHaveLength(2)
  })

  it('writes nothing at all rather than over a file it could not move aside', async () => {
    const path = join(directory, 'workspace.json')
    const original = '{"projects": [{"id": "p1"'
    await writeFile(path, original, 'utf8')
    // Nowhere to put it: something is already sitting where it would go.
    const occupied = join(directory, 'workspace.json.unreadable-2026-01-02T03-04-05-678Z')
    await mkdir(occupied)
    await writeFile(join(occupied, 'in-the-way'), 'x', 'utf8')
    const problems: StoreProblem[] = []

    const store = await WorkspaceStore.open(path, {
      onProblem: (problem) => problems.push(problem),
      now: () => Date.parse('2026-01-02T03:04:05.678Z')
    })
    store.putProject(project)
    await store.flush()

    expect(await readFile(path, 'utf8')).toBe(original)
    expect(problems.map((problem) => problem.kind)).toEqual(['unreadable', 'notWritten'])
  })

  // Finding out at shutdown that nothing has been saved all session is finding
  // out too late to do anything about it.
  it('reports a failing write when it fails, not when the app quits', async () => {
    const home = join(directory, 'state')
    await mkdir(home)
    const problems: StoreProblem[] = []
    const store = await WorkspaceStore.open(join(home, 'workspace.json'), {
      onProblem: (problem) => problems.push(problem)
    })

    // The place the file lives stops being a directory mid-session.
    await rm(home, { recursive: true })
    await writeFile(home, 'not a directory\n', 'utf8')
    store.putProject(project)
    await store.flush().catch(() => {})

    expect(problems.map((problem) => problem.kind)).toEqual(['writeFailed'])

    // And said once, however many mutations follow: a full disk is one fact.
    store.putWorktree(worktree('w1'))
    await store.flush().catch(() => {})
    expect(problems).toHaveLength(1)
  })

  it('describes each problem in terms of what it costs the user', () => {
    expect(describeStoreProblem({ kind: 'unreadable', filePath: '/w.json', reason: 'bad json' })).toContain(
      'opened with nothing in it'
    )
    expect(describeStoreProblem({ kind: 'keptAside', filePath: '/w.json', keptAt: '/w.json.old' })).toContain(
      '/w.json.old'
    )
    expect(describeStoreProblem({ kind: 'notWritten', filePath: '/w.json', reason: 'EACCES' })).toContain(
      'nothing is being saved'
    )
    expect(describeStoreProblem({ kind: 'writeFailed', filePath: '/w.json', reason: 'ENOSPC' })).toContain(
      'nothing has been saved since'
    )
  })

  it('drops rows that no longer match the entity shape and keeps the rest', async () => {
    const path = join(directory, 'workspace.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        projects: [project, { id: 'p2' }, 'garbage'],
        worktrees: [worktree('w1'), { id: 'w2', projectId: 'p1', state: 'exploded' }],
        layouts: [{ worktreeId: 'w1', root: null, focusedTerminalId: null }, { root: null }]
      }),
      'utf8'
    )

    const store = await WorkspaceStore.open(path)

    expect(store.listProjects()).toEqual([project])
    expect(store.listWorktrees().map((row) => row.id)).toEqual(['w1'])
    expect(store.getLayout('w1')).toEqual({ worktreeId: 'w1', root: null, focusedTerminalId: null })
  })

  it('removes a project together with its worktrees and layouts', async () => {
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    store.putProject(project)
    store.putWorktree(worktree('w1'))
    store.putLayout({ worktreeId: 'w1', root: null, focusedTerminalId: null })

    expect(store.removeProject('p1')).toBe(true)
    expect(store.removeProject('p1')).toBe(false)
    expect(store.snapshot()).toEqual({ projects: [], worktrees: [], layouts: [], terminals: [] })
  })
  // A question asked once has to stay asked across a quit, or "ask once" means
  // "ask once per launch" — which is the thing this exists to avoid.
  describe('one-time questions', () => {
    it('has asked nothing on a fresh installation', async () => {
      const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
      expect(store.askedAt('installCli')).toBeUndefined()
    })

    it('remembers the answer across a restart', async () => {
      const path = join(directory, 'workspace.json')
      const store = await WorkspaceStore.open(path)
      store.markAsked('installCli', 1700000000000)
      await store.flush()

      const reopened = await WorkspaceStore.open(path)
      expect(reopened.askedAt('installCli')).toBe(1700000000000)
    })

    it('keeps the first answer rather than moving the date on every launch', async () => {
      const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
      store.markAsked('installCli', 1700000000000)
      store.markAsked('installCli', 1800000000000)
      expect(store.askedAt('installCli')).toBe(1700000000000)
    })

    it('survives a file that has never heard of it, and one that has it wrong', async () => {
      const path = join(directory, 'workspace.json')
      await writeFile(path, JSON.stringify({ version: 1, projects: [project] }), 'utf8')
      expect((await WorkspaceStore.open(path)).askedAt('installCli')).toBeUndefined()

      await writeFile(path, JSON.stringify({ version: 1, asked: { installCli: 'yesterday' } }), 'utf8')
      expect((await WorkspaceStore.open(path)).askedAt('installCli')).toBeUndefined()
    })
  })

  describe('muted panes', () => {
    const terminal = (id: string): TerminalRecord => ({
      id,
      worktreeId: 'w1',
      cwd: '/repos/teamree',
      shell: '/bin/bash',
      cols: 80,
      rows: 24,
      createdAt: 1700000000000
    })

    it('mutes nothing on a fresh installation', async () => {
      const store = await WorkspaceStore.open(filePath)
      expect(store.listMutedTerminals()).toEqual([])
    })

    it('keeps a mute across a restart, because the pane comes back under its id', async () => {
      const store = await WorkspaceStore.open(filePath)
      store.putTerminal(terminal('t1'))
      store.setTerminalMuted('t1', true)
      await store.flush()

      const reopened = await WorkspaceStore.open(filePath)
      expect(reopened.listMutedTerminals()).toEqual(['t1'])
    })

    it('drops the mute with the record it was about, so nothing has to be swept', async () => {
      const store = await WorkspaceStore.open(filePath)
      store.putTerminal(terminal('t1'))
      store.setTerminalMuted('t1', true)
      store.removeTerminal('t1')
      await store.flush()

      const reopened = await WorkspaceStore.open(filePath)
      expect(reopened.listMutedTerminals()).toEqual([])
    })

    it('lifts a mute the owner lifts', async () => {
      const store = await WorkspaceStore.open(filePath)
      store.setTerminalMuted('t1', true)
      store.setTerminalMuted('t1', false)
      await store.flush()

      expect((await WorkspaceStore.open(filePath)).listMutedTerminals()).toEqual([])
    })

    it('survives a file that has never heard of mutes, and one that has them wrong', async () => {
      const path = join(directory, 'workspace.json')
      await writeFile(path, JSON.stringify({ version: 1, projects: [project] }), 'utf8')
      expect((await WorkspaceStore.open(path)).listMutedTerminals()).toEqual([])

      await writeFile(path, JSON.stringify({ version: 1, mutedTerminals: ['t1', 7, '', null] }), 'utf8')
      expect((await WorkspaceStore.open(path)).listMutedTerminals()).toEqual(['t1'])
    })
  })
  // The theme is a preference about the installation rather than about the
  // workspace, and it lives in this file for the same reason `asked` does: the
  // main process needs it before a window exists, to open that window in the
  // colour it is about to paint itself.
  describe('how this installation is painted', () => {
    it('opens on absolute black until somebody chooses otherwise', async () => {
      const store = await WorkspaceStore.open(filePath)
      expect(store.getAppearance()).toEqual(DEFAULT_APPEARANCE)
      expect(store.getAppearance().themeId).toBe('black')
    })

    it('is still there after the app is closed and opened again', async () => {
      const store = await WorkspaceStore.open(filePath)
      store.setAppearance({ themeId: 'graphite', ground: '#101820', accent: '#3fbfa6', overrides: { line: '#445566' } })
      await store.flush()

      const reopened = await WorkspaceStore.open(filePath)
      expect(reopened.getAppearance()).toEqual({
        themeId: 'graphite',
        ground: '#101820',
        accent: '#3fbfa6',
        overrides: { line: '#445566' }
      })
    })

    // A colour file is hand-edited more often than anybody admits, and the cost
    // of being strict about one bad hex would be an app that opens with no
    // theme at all.
    it('keeps the colours it understands out of a file somebody has edited', async () => {
      const path = join(directory, 'workspace.json')
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          appearance: {
            themeId: 'a theme that was removed',
            ground: 'rebeccapurple',
            accent: '#3fbfa6',
            overrides: { line: 'not a colour', 'bg-panel': '#123456', invented: '#123456' }
          }
        }),
        'utf8'
      )

      const store = await WorkspaceStore.open(path)
      expect(store.getAppearance()).toEqual({
        themeId: 'black',
        ground: null,
        accent: '#3fbfa6',
        overrides: { 'bg-panel': '#123456' }
      })
    })

    it('survives a file that has never heard of a theme', async () => {
      const path = join(directory, 'workspace.json')
      await writeFile(path, JSON.stringify({ version: 1, projects: [project] }), 'utf8')
      expect((await WorkspaceStore.open(path)).getAppearance()).toEqual(DEFAULT_APPEARANCE)
    })
  })

  describe('standing permission to type', () => {
    const terminal = (id: string): TerminalRecord => ({
      id,
      worktreeId: 'w1',
      cwd: '/repos/teamree',
      shell: '/bin/bash',
      cols: 80,
      rows: 24,
      createdAt: 1700000000000
    })
    const ANA = 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM='
    const BO = 'Qp2WdTn6Ys4aRk0uEbV8cMxJfZ1gLh3XoIvNtAj5BrM='

    it('allows nobody on a fresh installation', async () => {
      expect((await WorkspaceStore.open(filePath)).listStandingConsent()).toEqual([])
    })

    it('keeps a permission across a restart, because the pane comes back under its id', async () => {
      const store = await WorkspaceStore.open(filePath)
      store.putTerminal(terminal('t1'))
      store.setStandingConsent('t1', ANA, 1700000000000)
      await store.flush()

      const reopened = await WorkspaceStore.open(filePath)
      expect(reopened.listStandingConsent()).toEqual([{ terminalId: 't1', publicKey: ANA, since: 1700000000000 }])
    })

    it('is per person as well as per pane, so allowing one is not allowing everyone', async () => {
      const store = await WorkspaceStore.open(filePath)
      store.setStandingConsent('t1', ANA, 1)
      store.setStandingConsent('t1', BO, 2)
      store.setStandingConsent('t1', ANA, null)
      await store.flush()

      expect((await WorkspaceStore.open(filePath)).listStandingConsent()).toEqual([
        { terminalId: 't1', publicKey: BO, since: 2 }
      ])
    })

    it('drops the permission with the record it was about, so nothing has to be swept', async () => {
      const store = await WorkspaceStore.open(filePath)
      store.putTerminal(terminal('t1'))
      store.setStandingConsent('t1', ANA, 1)
      store.removeTerminal('t1')
      await store.flush()

      expect((await WorkspaceStore.open(filePath)).listStandingConsent()).toEqual([])
    })

    it('survives a file that has never heard of permissions, and one that has them wrong', async () => {
      const path = join(directory, 'workspace.json')
      await writeFile(path, JSON.stringify({ version: 1, projects: [project] }), 'utf8')
      expect((await WorkspaceStore.open(path)).listStandingConsent()).toEqual([])

      // Salvaged row by row, like everything else here: a permission nobody can
      // read is not a permission, and refusing the whole file over one would
      // lose the ones that are still good.
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          standingConsent: [{ terminalId: 't1', publicKey: ANA, since: 1 }, { terminalId: 't2' }, null, 7]
        }),
        'utf8'
      )
      expect((await WorkspaceStore.open(path)).listStandingConsent()).toEqual([
        { terminalId: 't1', publicKey: ANA, since: 1 }
      ])
    })
  })
})
