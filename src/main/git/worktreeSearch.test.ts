// Content search against real git in a throwaway repository, and ripgrep through
// a stand-in script: its argv and line format are what the engine depends on.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SearchFileHits } from '../../shared/search'
import { createTempRepo, type TempRepo } from './testRepository'
import { parseSearchLine, searchArgs, startSearch, type SearchRequest } from './worktreeSearch'

let repo: TempRepo | null = null
let scratch: string | null = null

afterEach(async () => {
  await repo?.cleanup()
  repo = null
  if (scratch !== null) await rm(scratch, { recursive: true, force: true })
  scratch = null
})

async function fixture(): Promise<TempRepo> {
  const made = await createTempRepo()
  await made.write('.gitignore', 'dist/\n')
  await made.write('src/limits.ts', 'export const LIMIT = 3\n')
  await made.write('src/middleware.ts', 'limit()\nconst x = limit(2)\n// unlimited\n')
  await made.write('docs/guide.md', 'Call limit( before sending.\n')
  await made.commit('files to search')
  await made.write('dist/bundle.js', 'limit()\n')
  await made.write('src/fresh.ts', 'limit() from an agent\n')
  await writeFile(path.join(made.repoPath, 'blob.bin'), Buffer.from([0, 1, 2, 108, 105, 109, 105, 116, 0]))
  return made
}

type Collected = { files: SearchFileHits[]; summary: Awaited<ReturnType<typeof startSearch>['done']> }

async function collect(request: Omit<SearchRequest, 'onHits'>): Promise<Collected> {
  const files: SearchFileHits[] = []
  const run = startSearch({ ...request, onHits: (batch) => files.push(...batch) })
  return { files, summary: await run.done }
}

function paths(files: SearchFileHits[]): string[] {
  return [...new Set(files.map((file) => `${file.worktreeId}:${file.path}`))].sort()
}

async function standIn(body: string): Promise<string> {
  scratch = await mkdtemp(path.join(await realTmp(), 'teamree-rg-'))
  const script = path.join(scratch, 'rg')
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.args"\n${body}\n`)
  await chmod(script, 0o755)
  return script
}

async function realTmp(): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(os.tmpdir())
}

describe('git grep', () => {
  it('finds a literal case-insensitively, in tracked and untracked files, skipping ignored and binary ones', async () => {
    repo = await fixture()
    const { files, summary } = await collect({
      targets: [{ worktreeId: 'w1', path: repo.repoPath }],
      query: 'limit(',
      rg: null,
      git: 'git'
    })
    expect(summary).toMatchObject({ engine: 'git', truncated: false, timedOut: false, cancelled: false, matches: 4 })
    expect(paths(files)).toEqual(['w1:docs/guide.md', 'w1:src/fresh.ts', 'w1:src/middleware.ts'])
    const middleware = files.find((file) => file.path === 'src/middleware.ts')
    expect(middleware?.lines.map((line) => line.line)).toEqual([1, 2])
    expect(middleware?.lines[1]).toEqual({ line: 2, column: 11, text: 'const x = limit(2)', ranges: [[10, 16]] })
  })

  it('takes a regex, whole words and case', async () => {
    repo = await fixture()
    const target = [{ worktreeId: 'w1', path: repo.repoPath }]
    const regex = await collect({ targets: target, query: 'limit\\([0-9]', regex: true, rg: null, git: 'git' })
    expect(regex.files.flatMap((file) => file.lines.map((line) => line.text))).toEqual(['const x = limit(2)'])

    const cased = await collect({ targets: target, query: 'LIMIT', caseSensitive: true, rg: null, git: 'git' })
    expect(paths(cased.files)).toEqual(['w1:src/limits.ts'])

    const word = await collect({ targets: target, query: 'unlimited', wholeWord: true, rg: null, git: 'git' })
    expect(word.summary.matches).toBe(1)
    const partial = await collect({ targets: target, query: 'limite', wholeWord: true, rg: null, git: 'git' })
    expect(partial.summary.matches).toBe(0)
  })

  it('narrows to globs and excludes with a leading !', async () => {
    repo = await fixture()
    const target = [{ worktreeId: 'w1', path: repo.repoPath }]
    const onlyTs = await collect({
      targets: target,
      query: 'limit',
      include: ['*.ts', '!src/fresh.ts'],
      rg: null,
      git: 'git'
    })
    expect(paths(onlyTs.files)).toEqual(['w1:src/limits.ts', 'w1:src/middleware.ts'])
  })

  it('reports a regex the engine refuses', async () => {
    repo = await fixture()
    const { summary } = await collect({
      targets: [{ worktreeId: 'w1', path: repo.repoPath }],
      query: 'limit(',
      regex: true,
      rg: null,
      git: 'git'
    })
    expect(summary.matches).toBe(0)
    expect(summary.error).toBeTruthy()
  })

  it('searches every worktree named, labelling each hit with its own', async () => {
    repo = await fixture()
    const second = path.join(repo.worktreesRoot, 'rate')
    await repo.git(['worktree', 'add', '-b', 'rate', second])
    await repo.write('src/rate.ts', 'rateLimit()\n', second)
    const { files } = await collect({
      targets: [
        { worktreeId: 'w1', path: repo.repoPath },
        { worktreeId: 'w2', path: second }
      ],
      query: 'limit(',
      rg: null,
      git: 'git'
    })
    expect(paths(files)).toEqual([
      'w1:docs/guide.md',
      'w1:src/fresh.ts',
      'w1:src/middleware.ts',
      'w2:docs/guide.md',
      'w2:src/middleware.ts',
      'w2:src/rate.ts'
    ])
  })

  it('stops at the cap and says so', async () => {
    repo = await createTempRepo()
    await repo.write('many.txt', Array.from({ length: 500 }, (_, index) => `hit ${index}`).join('\n'))
    await repo.commit('many')
    const { files, summary } = await collect({
      targets: [{ worktreeId: 'w1', path: repo.repoPath }],
      query: 'hit',
      limit: 20,
      rg: null,
      git: 'git'
    })
    expect(summary).toMatchObject({ matches: 20, truncated: true })
    expect(files.flatMap((file) => file.lines)).toHaveLength(20)
  })
})

describe('ripgrep', () => {
  it('is run from the worktree root with gitignore, hidden files, and the options as flags', async () => {
    const rg = await standIn(
      `printf './src/a.ts\\000%s\\n' '3:const limit = 1'\nprintf './README.md\\000%s\\n' '12:Limit: none'`
    )
    const { files, summary } = await collect({
      targets: [{ worktreeId: 'w1', path: os.tmpdir() }],
      query: 'limit',
      wholeWord: true,
      include: ['src/**'],
      rg,
      git: 'git'
    })
    expect(summary).toMatchObject({ engine: 'rg', matches: 2 })
    expect(files).toEqual([
      {
        worktreeId: 'w1',
        path: 'src/a.ts',
        lines: [{ line: 3, column: 7, text: 'const limit = 1', ranges: [[6, 11]] }]
      },
      { worktreeId: 'w1', path: 'README.md', lines: [{ line: 12, column: 1, text: 'Limit: none', ranges: [[0, 5]] }] }
    ])
    const argv = (await readFile(`${rg}.args`, 'utf8')).trim().split('\n')
    expect(argv).toEqual(searchArgs('rg', { query: 'limit', wholeWord: true, include: ['src/**'] }))
    expect(argv).toEqual(
      expect.arrayContaining(['--hidden', '--ignore-case', '--word-regexp', '--fixed-strings', '--glob=src/**'])
    )
    expect(argv.slice(-4)).toEqual(['--regexp', 'limit', '--', '.'])
  })

  it('reports the reason ripgrep gives for refusing a regex', async () => {
    const rg = await standIn(
      `printf 'rg: regex parse error:\\n    (?:limit(take)\\n    ^\\nerror: unclosed group\\n' >&2\nexit 2`
    )
    const { summary } = await collect({
      targets: [{ worktreeId: 'w1', path: os.tmpdir() }],
      query: 'limit(take',
      regex: true,
      rg,
      git: 'git'
    })
    expect(summary).toMatchObject({ matches: 0, error: 'unclosed group' })
  })

  it('is killed at the cap', async () => {
    const rg = await standIn(`while :; do printf './x\\000%s\\n' '1:hit'; done`)
    const { files, summary } = await collect({
      targets: [{ worktreeId: 'w1', path: os.tmpdir() }],
      query: 'hit',
      limit: 100,
      rg,
      git: 'git'
    })
    expect(summary).toMatchObject({ matches: 100, truncated: true, timedOut: false })
    expect(files.flatMap((file) => file.lines)).toHaveLength(100)
  })

  it('is killed on cancel, and nothing more is handed on', async () => {
    const rg = await standIn(`printf './x\\000%s\\n' '1:hit'\nexec sleep 30`)
    const files: SearchFileHits[] = []
    const run = startSearch({
      targets: [{ worktreeId: 'w1', path: os.tmpdir() }],
      query: 'hit',
      rg,
      git: 'git',
      flushMs: 10,
      onHits: (batch) => files.push(...batch)
    })
    for (let waited = 0; files.length === 0 && waited < 5000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const before = files.length
    const cancelledAt = Date.now()
    run.cancel()
    const summary = await run.done
    expect(Date.now() - cancelledAt).toBeLessThan(1500)
    expect(summary).toMatchObject({ cancelled: true, truncated: false })
    expect(before).toBe(1)
    expect(files).toHaveLength(before)
  })

  it('gives up at the deadline with what it found', async () => {
    const rg = await standIn(`printf './x\\000%s\\n' '1:hit'\nexec sleep 30`)
    const { files, summary } = await collect({
      targets: [{ worktreeId: 'w1', path: os.tmpdir() }],
      query: 'hit',
      rg,
      git: 'git',
      timeoutMs: 300
    })
    expect(summary).toMatchObject({ timedOut: true, matches: 1 })
    expect(files).toHaveLength(1)
  })
})

describe('parseSearchLine', () => {
  it('reads each engine’s format and refuses anything else', () => {
    expect(parseSearchLine('git', 'a:b.ts\u00004\u0000x: y')).toEqual({ path: 'a:b.ts', line: 4, text: 'x: y' })
    expect(parseSearchLine('rg', './a:b.ts\u00004:x: y')).toEqual({ path: 'a:b.ts', line: 4, text: 'x: y' })
    expect(parseSearchLine('rg', 'Binary file matches')).toBeNull()
    expect(parseSearchLine('git', 'x\u0000nope\u0000y')).toBeNull()
  })
})
