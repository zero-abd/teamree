// The one column of `worktree list` that is computed rather than copied: a
// checkout deleted from disk keeps a `ready` record, and a listing that printed
// that word over a path that is not there would be the CLI repeating the
// sidebar's old mistake.

import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities.js'
import { compareText, shownState } from './worktree.js'

describe('the state column', () => {
  it('prints the record’s state while the checkout is where it says', () => {
    expect(shownState({ state: 'ready' })).toBe('ready')
    expect(shownState({ state: 'creating' })).toBe('creating')
  })

  it('says missing over a ready record whose directory has gone', () => {
    expect(shownState({ state: 'ready', missing: true })).toBe('missing')
  })
})

describe('comparing two runs', () => {
  const run = (id: string, name: string): Worktree => ({
    id,
    projectId: 'p1',
    name,
    branch: name.replace(/ /g, '-'),
    path: `/wt/${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1
  })
  const patch = (path: string, line: string, fresh = false): string =>
    [
      `diff --git a/${path} b/${path}`,
      ...(fresh ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
      `+++ b/${path}`,
      '@@ -0,0 +1 @@',
      `+${line}`,
      ''
    ].join('\n')
  const SUB = patch('src/math.ts', 'export const sub = (a, b) => a - b')

  it('names both runs and their start, lists each file with what each run did, then the patches', () => {
    const text = compareText(
      {
        base: 'c'.repeat(40),
        left: {
          worktreeId: 'w1',
          head: 'a'.repeat(40),
          patch: SUB + patch('src/math.test.ts', 'test()', true),
          truncated: false
        },
        right: { worktreeId: 'w2', head: 'c'.repeat(40), patch: SUB, truncated: false },
        readAt: 0
      },
      run('w1', 'sub claude'),
      run('w2', 'sub codex')
    )
    const [head, table, ...patches] = text.split('\n\n')
    expect(head).toBe(['a:    sub claude', 'b:    sub codex', 'base: ccccccc'].join('\n'))
    expect(table).toBe(
      [
        'FILE              A      B',
        'src/math.test.ts  +1 -0  -      only a',
        'src/math.ts       +1 -0  +1 -0  same'
      ].join('\n')
    )
    expect(patches).toEqual([
      `== a  src/math.test.ts\n${patch('src/math.test.ts', 'test()', true).trimEnd()}`,
      `== a b  src/math.ts\n${SUB.trimEnd()}`
    ])
  })

  it('says so when neither run has changed anything', () => {
    const empty = { worktreeId: 'w1', head: 'c'.repeat(40), patch: '', truncated: false }
    const text = compareText(
      { base: 'c'.repeat(40), left: empty, right: empty, readAt: 0 },
      run('w1', 'a'),
      run('w2', 'b')
    )
    expect(text.split('\n\n')[1]).toBe('Neither run has changed anything.')
  })
})
