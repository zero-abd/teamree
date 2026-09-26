import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listIssues, MAX_ISSUE_BODY_CHARS, parseIssues } from './issues'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A script named gh that logs its arguments and answers with `stdout`, or fails with `stderr`. */
async function standInGh(answer: { stdout?: string; stderr?: string }): Promise<{ gh: string; log: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'teamree-issues-'))
  dirs.push(dir)
  const gh = path.join(dir, 'gh')
  const log = path.join(dir, 'gh.log')
  const lines = ['#!/bin/sh', `echo "$*" >> '${log}'`]
  if (answer.stderr !== undefined) lines.push(`echo '${answer.stderr}' >&2`, 'exit 1')
  else lines.push(`cat <<'JSON'`, answer.stdout ?? '[]', 'JSON')
  await writeFile(gh, `${lines.join('\n')}\n`, 'utf8')
  await chmod(gh, 0o755)
  return { gh, log }
}

const FIXTURE = [
  {
    number: 123,
    title: 'Login redirect loops',
    url: 'https://github.com/acme/pantry/issues/123',
    labels: [{ name: 'bug' }, { name: 'auth' }],
    body: 'Steps:\r\n1. Sign in\r\n',
    updatedAt: '2026-09-01T00:00:00Z'
  },
  { number: 7, title: 'Dark mode', url: 'https://github.com/acme/pantry/issues/7', labels: [], body: null }
]

describe('parseIssues', () => {
  it('reads number, title, url, label names, body and time', () => {
    expect(parseIssues(JSON.stringify(FIXTURE))).toEqual([
      {
        number: 123,
        title: 'Login redirect loops',
        url: 'https://github.com/acme/pantry/issues/123',
        labels: ['bug', 'auth'],
        body: 'Steps:\n1. Sign in\n',
        updatedAt: Date.parse('2026-09-01T00:00:00Z')
      },
      {
        number: 7,
        title: 'Dark mode',
        url: 'https://github.com/acme/pantry/issues/7',
        labels: [],
        body: '',
        updatedAt: null
      }
    ])
  })

  it('skips an entry without a number, title or url, and refuses what is not a list', () => {
    expect(parseIssues(JSON.stringify([{ number: 1, title: 'x' }, FIXTURE[1]]))?.map((issue) => issue.number)).toEqual([
      7
    ])
    expect(parseIssues('{"number":1}')).toBeNull()
    expect(parseIssues('not json')).toBeNull()
  })

  it('bounds a long body', () => {
    const [issue] = parseIssues(JSON.stringify([{ ...FIXTURE[1], body: 'x'.repeat(MAX_ISSUE_BODY_CHARS * 2) }])) ?? []
    expect(issue?.body.length).toBe(MAX_ISSUE_BODY_CHARS)
  })
})

describe('listIssues', () => {
  it('lists open issues through gh, bounded', async () => {
    const { gh, log } = await standInGh({ stdout: JSON.stringify(FIXTURE) })

    const read = await listIssues(gh, os.tmpdir())

    expect(read.available).toBe(true)
    expect(read.issues.map((issue) => issue.number)).toEqual([123, 7])
    expect((await readFile(log, 'utf8')).trim()).toBe(
      'issue list --state open --limit 100 --json number,title,url,labels,body,updatedAt'
    )
  })

  it('needs gh when there is none', async () => {
    expect(await listIssues(null, os.tmpdir())).toEqual({ available: false, reason: 'Needs gh', issues: [] })
  })

  it('needs gh signed in when it is not', async () => {
    const { gh } = await standInGh({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' })
    expect(await listIssues(gh, os.tmpdir())).toEqual({ available: false, reason: 'Needs gh auth login', issues: [] })
  })

  it('says what gh said for any other failure', async () => {
    const { gh } = await standInGh({ stderr: 'no git remotes found' })
    expect(await listIssues(gh, os.tmpdir())).toEqual({ available: false, reason: 'no git remotes found', issues: [] })
  })
})
