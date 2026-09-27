// The ledger with the Jac Graph Memory add-on in front of it, played by a fake provider:
// what it adds when it answers, and that the ledger answers alone when it is slow, wrong or absent.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryEvent } from '../../shared/contextProvider'
import type { Project, Worktree } from '../../shared/entities'
import type { GraphAnswer, GraphAsk, RiskRow } from '../../shared/graphMemory'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { ContextLedger } from './contextLedger'
import type { ContextProvider } from './source'

let repo: TempRepo
let dataDir: string
let project: Project
let worktrees: Worktree[]
let ledger: ContextLedger
let providers: ContextProvider[]
let heard: { projectId: string; event: MemoryEvent }[]
let asked: GraphAsk[]

const coChange = (worktreeId: string, name: string): RiskRow => ({
  path: 'src/db.ts',
  kind: 'co-change',
  worktreeId,
  name,
  owner: 'me',
  via: 'src/api.ts',
  together: 3,
  of: 4
})

function graph(answer: (ask: GraphAsk) => Promise<GraphAnswer>): ContextProvider {
  return {
    name: 'jac-memory',
    context: async () => ({}),
    observe: (projectId, event) => heard.push({ projectId, event }),
    ask: (_, ask) => {
      asked.push(ask)
      return answer(ask)
    }
  }
}

async function addWorktree(id: string, task: string, parentId?: string): Promise<Worktree> {
  const checkout = path.join(repo.worktreesRoot, id)
  await repo.git(['worktree', 'add', '-b', id, checkout, 'main'])
  const worktree: Worktree = {
    id,
    projectId: project.id,
    name: id,
    branch: id,
    path: checkout,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 1,
    task,
    ...(parentId === undefined ? {} : { parentId })
  }
  worktrees.push(worktree)
  return worktree
}

beforeEach(async () => {
  repo = await createTempRepo()
  dataDir = await mkdtemp(path.join(tmpdir(), 'teamree-graph-data-'))
  await repo.write('src/api.ts', 'api\n')
  await repo.write('src/db.ts', 'db\n')
  await repo.commit('The API reads through one pool (#12)')
  project = { id: 'p1', name: 'repo', path: repo.repoPath, baseRef: 'main' }
  worktrees = []
  providers = []
  heard = []
  asked = []
  ledger = new ContextLedger({
    dataDir,
    runner: repo.runner,
    snapshot: () => ({ projects: [project], worktrees }),
    providers: () => providers
  })
})

afterEach(async () => {
  await ledger.close()
  await repo.cleanup()
  await rm(dataDir, { recursive: true, force: true })
})

describe('the ledger with the graph add-on', () => {
  it('tells an agent before an edit about a sibling on a file that usually changes with it, once', async () => {
    const a = await addWorktree('a', 'Page the list endpoint')
    const b = await addWorktree('b', 'Tune the pool')
    await repo.write('src/db.ts', 'db tuned\n', b.path)
    await ledger.refresh()
    providers = [
      graph(async () => ({
        walker: 'conflict_risk',
        rows: [coChange('b', 'b'), coChange('gone', 'gone'), { ...coChange('b', 'b'), kind: 'touched' }],
        predicted: []
      }))
    ]

    const check = await ledger.check({ worktreeId: 'a', path: path.join(a.path, 'src/api.ts'), hook: true })
    expect(check.likely).toEqual([coChange('b', 'b')])
    expect(check.text).toBe(
      [
        'src/api.ts usually changes with src/db.ts (3 of 4 commits), which b is changing.',
        'Coordinate first: teamree msg ask --to b "<question>", or pick another file.'
      ].join('\n')
    )
    expect(asked).toEqual([{ walker: 'conflict_risk', worktreeId: 'a', paths: ['src/api.ts'] }])
    const again = await ledger.check({ worktreeId: 'a', path: path.join(a.path, 'src/api.ts'), hook: true })
    expect(again.text).toBe('')
  })

  it('answers the edit hook from the ledger alone when the add-on is slow or broken', async () => {
    const a = await addWorktree('a', 'Page the list endpoint')
    await addWorktree('b', 'Tune the pool')
    await ledger.refresh()
    providers = [graph(() => new Promise(() => {}))]
    const started = Date.now()
    const slow = await ledger.check({ worktreeId: 'a', path: path.join(a.path, 'src/api.ts'), hook: true })
    expect(Date.now() - started).toBeLessThan(900)
    expect(slow).toEqual({ worktreeId: 'a', path: 'src/api.ts', siblings: [], text: '' })

    providers = [
      graph(async () => {
        throw new Error('crashed')
      })
    ]
    expect(await ledger.check({ worktreeId: 'a', path: 'src/api.ts' })).toEqual(slow)
    providers = [graph(async () => ({ walker: 'related_work', tasks: [] }))]
    expect(await ledger.check({ worktreeId: 'a', path: 'src/api.ts' })).toEqual(slow)
  })

  it('ranks a planned edit against siblings and teammates, and adds co-change when the add-on answers', async () => {
    const a = await addWorktree('a', 'Page the list endpoint')
    const b = await addWorktree('b', 'Tune the pool')
    await repo.write('src/api.ts', 'api from b\n', b.path)
    await ledger.refresh()
    const teammate = { handle: 'grace', worktreeId: 'g1', name: 'auth', paths: ['src/api.ts'] }

    const alone = await ledger.risk({
      worktreeId: 'a',
      paths: [path.join(a.path, 'src/api.ts')],
      teammates: [teammate]
    })
    expect(alone).toMatchObject({ source: 'ledger', predicted: [] })
    expect(alone.rows).toEqual([
      { path: 'src/api.ts', kind: 'touched', worktreeId: 'b', name: 'b', owner: 'me' },
      { path: 'src/api.ts', kind: 'touched', worktreeId: 'g1', name: 'auth', owner: 'grace' }
    ])
    expect(alone.text).toBe("b also changes src/api.ts.\ngrace's auth also changes src/api.ts.")

    providers = [
      graph(async () => ({
        walker: 'conflict_risk',
        rows: [
          { path: 'src/api.ts', kind: 'touched', worktreeId: 'b', name: 'b', owner: 'me' },
          { path: 'src/api.ts', kind: 'touched', worktreeId: 'g1', name: 'auth', owner: 'grace' },
          coChange('b', 'b')
        ],
        predicted: [{ path: 'src/db.ts', with: 'src/api.ts', together: 3, of: 4 }]
      }))
    ]
    const withGraph = await ledger.risk({ worktreeId: 'a', paths: ['src/api.ts'], teammates: [teammate] })
    expect(withGraph.source).toBe('jac-memory')
    expect(withGraph.rows.map((row) => `${row.kind} ${row.owner} ${row.path}`)).toEqual([
      'touched me src/api.ts',
      'touched grace src/api.ts',
      'co-change me src/db.ts'
    ])
    expect(asked[0]).toEqual({ walker: 'conflict_risk', worktreeId: 'a', paths: ['src/api.ts'], teammates: [teammate] })
  })

  it('says why a file is as it is from history, with the ledger’s decisions on it', async () => {
    const a = await addWorktree('a', 'Page the list endpoint')
    await ledger.note({ worktreeId: 'a', kind: 'decision', text: 'Pages are cursor based', paths: ['src/**'] })
    const alone = await ledger.why({ worktreeId: 'a', path: path.join(a.path, 'src/api.ts') })
    expect(alone).toMatchObject({ path: 'src/api.ts', source: 'ledger', changes: 1 })
    expect(alone.tasks.map((task) => [task.name, task.pr])).toEqual([['The API reads through one pool (#12)', 12]])
    expect(alone.decisions.map((row) => [row.text, row.worktree])).toEqual([['Pages are cursor based', 'a']])
    expect(alone.text).toContain('decided in a: Pages are cursor based')

    providers = [
      graph(async () => ({
        walker: 'why_file',
        path: 'src/api.ts',
        changes: 9,
        tasks: [
          {
            key: 'pr:7',
            name: 'rate-limit-the-api',
            branch: 'rate-limit-the-api',
            pr: 7,
            goal: 'Rate limit the public API',
            at: 1_700_000_000,
            outcome: 'merged',
            reasons: ['The API asks the limiter before each handler']
          }
        ],
        decisions: [{ text: 'Pool size comes from env', at: 1, worktree: 'pool-sizes', outcome: 'landed' }],
        people: [{ name: 'Linus', commits: 2 }]
      }))
    ]
    const graphed = await ledger.why({ worktreeId: 'a', path: 'src/api.ts' })
    expect(graphed.source).toBe('jac-memory')
    expect(graphed.text).toBe(
      [
        '#7 rate-limit-the-api 2023-11-14: Rate limit the public API',
        '  - The API asks the limiter before each handler',
        'decided in pool-sizes: Pool size comes from env',
        'decided in a: Pages are cursor based',
        'by Linus (2)'
      ].join('\n')
    )
  })

  it('mirrors the project, each worktree and its touches to the add-on, and replays them to a fresh one', async () => {
    const a = await addWorktree('a', 'Page the list endpoint')
    await repo.write('src/api.ts', 'api from a\n', a.path)
    providers = [graph(async () => ({ walker: 'related_work', tasks: [] }))]
    await ledger.refresh()
    expect(heard.map((row) => row.event.type)).toEqual(['worktree', 'touch', 'project'])
    expect(heard[1]?.event).toMatchObject({ type: 'touch', touch: { worktreeId: 'a', paths: ['src/api.ts'] } })

    heard = []
    await ledger.refresh()
    expect(heard).toEqual([])
    await ledger.claim({ worktreeId: 'a', globs: ['src/api/**'] })
    expect(heard.map((row) => row.event)).toEqual([
      { type: 'worktree', worktree: expect.objectContaining({ id: 'a', claims: ['src/api/**'] }) }
    ])

    const snapshot = await ledger.providerSnapshot()
    expect(snapshot.map((row) => row.event.type)).toEqual(['project', 'worktree', 'touch'])

    heard = []
    worktrees = []
    await ledger.refresh()
    expect(heard.map((row) => row.event)).toContainEqual({ type: 'worktreeRemoved', worktreeId: 'a' })
  })

  it('adds earlier work to the bundle when the add-on finds some', async () => {
    await addWorktree('a', 'Rate limit the API again')
    providers = [
      {
        name: 'jac-memory',
        context: async () => ({
          related: [
            {
              key: 'pr:7',
              name: 'rate-limit-the-api',
              branch: 'rate-limit-the-api',
              pr: 7,
              goal: 'Rate limit the public API',
              at: 1,
              outcome: 'merged',
              score: 9,
              files: [],
              terms: ['limit', 'api'],
              decisions: ['Counters live in the database']
            }
          ]
        })
      }
    ]
    const context = await ledger.context({ worktreeId: 'a' })
    expect(context.text).toBe('earlier: #7 rate-limit-the-api (merged): Counters live in the database')
    expect(context.sources?.map((row) => row.name)).toEqual(['jac-memory', 'ledger'])
  })
})
