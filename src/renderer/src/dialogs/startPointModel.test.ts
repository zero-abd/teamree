// The picker's contract: filter without re-sorting, walk with the arrow keys,
// group by kind, and never let a typed ref be swallowed by the filter.

import { describe, expect, it } from 'vitest'
import type { StartPoint, StartPointList } from '@shared/entities'
import {
  buildPickerModel,
  choiceOf,
  commitStartPoint,
  defaultActiveId,
  edgeActiveId,
  idForRef,
  moveActiveId,
  rowById,
  startPointErrorText,
  startPointOptionId,
  TYPED_ROW_ID
} from './startPointModel'

let clock = 1_700_000_000

function option(ref: string, kind: StartPoint['kind'], extra: Partial<StartPoint> = {}): StartPoint {
  const sha = `${ref.replace(/[^a-z0-9]/g, '')}0000000000000000000000000000`.slice(0, 40)
  return {
    ref,
    kind,
    sha,
    shortSha: sha.slice(0, 7),
    refName: kind === 'commit' ? undefined : `refs/${kind === 'tag' ? 'tags' : 'heads'}/${ref}`,
    isBase: false,
    isCurrent: false,
    updatedAt: clock--,
    ...extra
  }
}

function list(options: StartPoint[], extra: Partial<StartPointList> = {}): StartPointList {
  return { baseRef: 'origin/main', options, total: options.length, limit: 200, truncated: false, ...extra }
}

const sample = list([
  option('origin/main', 'remoteBranch', { isBase: true }),
  option('main', 'localBranch', { isCurrent: true }),
  option('task/pager', 'localBranch'),
  option('task/indexer', 'localBranch'),
  option('origin/release-4.2', 'remoteBranch'),
  option('origin/task/pager', 'remoteBranch'),
  option('v4.1.0', 'tag'),
  option('v4.0.0', 'tag')
])

const refsOf = (model: ReturnType<typeof buildPickerModel>): string[] =>
  model.rows.map((row) => (row.kind === 'typed' ? `typed:${row.ref}` : row.option.ref))

describe('buildPickerModel grouping', () => {
  it('splits the options into base, local, remote and tag sections', () => {
    const model = buildPickerModel(sample, '')
    expect(model.groups.map((group) => group.id)).toEqual(['base', 'local', 'remote', 'tag'])
    expect(model.groups[0]!.rows.map((row) => row.option.ref)).toEqual(['origin/main'])
    expect(model.groups[3]!.rows.map((row) => row.option.ref)).toEqual(['v4.1.0', 'v4.0.0'])
  })

  it('keeps the base ref out of the remote section it would otherwise sit in', () => {
    const model = buildPickerModel(sample, '')
    const remote = model.groups.find((group) => group.id === 'remote')!
    expect(remote.rows.map((row) => row.option.ref)).toEqual(['origin/release-4.2', 'origin/task/pager'])
  })

  it('preserves the order the runtime returned within each group', () => {
    const unsorted = list([
      option('zeta', 'localBranch'),
      option('alpha', 'localBranch'),
      option('middle', 'localBranch')
    ])
    const model = buildPickerModel(unsorted, '')
    expect(model.groups[0]!.rows.map((row) => row.option.ref)).toEqual(['zeta', 'alpha', 'middle'])
  })

  it('drops an empty section rather than showing a bare heading', () => {
    const model = buildPickerModel(list([option('main', 'localBranch')]), '')
    expect(model.groups.map((group) => group.id)).toEqual(['local'])
  })

  it('files a raw commit under its own section', () => {
    const model = buildPickerModel(list([option('9f21ac4', 'commit')]), '')
    expect(model.groups.map((group) => group.id)).toEqual(['other'])
  })
})

describe('buildPickerModel filtering', () => {
  it('matches the short ref case-insensitively, across every section', () => {
    const model = buildPickerModel(sample, 'PAGER')
    expect(refsOf(model)).toEqual(['typed:PAGER', 'task/pager', 'origin/task/pager'])
  })

  it('matches the full ref name too', () => {
    const model = buildPickerModel(sample, 'refs/tags/v4.1')
    expect(refsOf(model)).toEqual(['typed:refs/tags/v4.1', 'v4.1.0'])
  })

  it('matches a sha by its prefix only', () => {
    const first = sample.options[0]!
    expect(refsOf(buildPickerModel(sample, first.sha.slice(0, 6)))).toContain('origin/main')
    const inner = buildPickerModel(sample, first.sha.slice(8, 14))
    expect(inner.rows.some((row) => row.kind === 'option')).toBe(false)
  })

  it('gives an exactly named ref no duplicate typed row', () => {
    const model = buildPickerModel(sample, 'task/pager')
    expect(model.typed).toBeNull()
    expect(refsOf(model)).toEqual(['task/pager', 'origin/task/pager'])
  })

  it('keeps row ids stable as the query narrows', () => {
    const wide = buildPickerModel(sample, '')
    const narrow = buildPickerModel(sample, 'v4.1')
    const wideRow = wide.rows.find((row) => row.kind === 'option' && row.option.ref === 'v4.1.0')!
    const narrowRow = narrow.rows.find((row) => row.kind === 'option' && row.option.ref === 'v4.1.0')!
    expect(narrowRow.id).toBe(wideRow.id)
    expect(narrowRow.id).toBe(startPointOptionId(6))
  })
})

describe('keyboard navigation', () => {
  it('starts on the first real option, not on the typed row', () => {
    const model = buildPickerModel(sample, 'pager')
    expect(rowById(model, defaultActiveId(model))).toMatchObject({ kind: 'option' })
    expect(defaultActiveId(model)).toBe(startPointOptionId(2))
  })

  it('falls back to the typed row when nothing matched', () => {
    const model = buildPickerModel(sample, 'no-such-ref')
    expect(defaultActiveId(model)).toBe(TYPED_ROW_ID)
  })

  it('walks down across section boundaries in listing order', () => {
    const model = buildPickerModel(sample, '')
    let active = defaultActiveId(model)
    const walked: string[] = []
    for (let step = 0; step < 4; step++) {
      active = moveActiveId(model, active, 1)
      walked.push((rowById(model, active) as { option: StartPoint }).option.ref)
    }
    expect(walked).toEqual(['main', 'task/pager', 'task/indexer', 'origin/release-4.2'])
  })

  it('wraps at both ends', () => {
    const model = buildPickerModel(sample, '')
    const first = model.rows[0]!.id
    const last = model.rows[model.rows.length - 1]!.id
    expect(moveActiveId(model, first, -1)).toBe(last)
    expect(moveActiveId(model, last, 1)).toBe(first)
  })

  it('includes the typed row in the walk, so a typed ref is always reachable', () => {
    const model = buildPickerModel(sample, 'pag')
    expect(moveActiveId(model, model.rows[0]!.id, -1)).toBe(model.rows[model.rows.length - 1]!.id)
    expect(moveActiveId(model, startPointOptionId(2), -1)).toBe(TYPED_ROW_ID)
  })

  it('jumps to either end and survives an unknown active row', () => {
    const model = buildPickerModel(sample, '')
    expect(edgeActiveId(model, 'first')).toBe(model.rows[0]!.id)
    expect(edgeActiveId(model, 'last')).toBe(model.rows[model.rows.length - 1]!.id)
    expect(moveActiveId(model, 'startpoint-option-999', 1)).toBe(model.rows[0]!.id)
  })

  it('finds the row for a ref already in the box, so opening lands on it', () => {
    const model = buildPickerModel(sample, '')
    expect(idForRef(model, 'v4.1.0')).toBe(startPointOptionId(6))
    expect(idForRef(model, 'origin/nothing')).toBeNull()
  })

  it('has nothing to move to in an empty listing', () => {
    const empty = buildPickerModel(list([]), '')
    expect(defaultActiveId(empty)).toBeNull()
    expect(moveActiveId(empty, null, 1)).toBeNull()
  })
})

describe('selection', () => {
  it('commits the highlighted option with the sha it resolves to', () => {
    const model = buildPickerModel(sample, '')
    const choice = commitStartPoint({ model, activeId: startPointOptionId(4), query: '', open: true })
    expect(choice).toEqual({ ref: 'origin/release-4.2', option: sample.options[4] })
  })

  it('submits a typed ref that matches nothing at all', () => {
    const model = buildPickerModel(sample, 'origin/hotfix-9')
    const choice = commitStartPoint({ model, activeId: defaultActiveId(model), query: 'origin/hotfix-9', open: true })
    expect(choice).toEqual({ ref: 'origin/hotfix-9', option: null })
  })

  it('submits typed text with the list closed, matching or not', () => {
    const model = buildPickerModel(sample, '4f9a1c2')
    expect(commitStartPoint({ model, activeId: null, query: '4f9a1c2', open: false })).toEqual({
      ref: '4f9a1c2',
      option: null
    })
  })

  it('binds typed text back to the listed option when it names one exactly', () => {
    const model = buildPickerModel(sample, 'v4.0.0')
    expect(commitStartPoint({ model, activeId: null, query: 'v4.0.0', open: false })).toEqual({
      ref: 'v4.0.0',
      option: sample.options[7]
    })
  })

  it('refuses to commit an empty box', () => {
    const model = buildPickerModel(sample, '   ')
    expect(commitStartPoint({ model, activeId: null, query: '   ', open: false })).toBeNull()
  })

  it('carries a resolved sha for a listed row and none for typed text', () => {
    const listed = choiceOf(buildPickerModel(sample, '').rows[0]!)
    expect(listed.option?.shortSha).toHaveLength(7)
    expect(choiceOf(buildPickerModel(sample, 'zzz').rows[0]!).option).toBeNull()
  })
})

describe('a truncated listing', () => {
  const capped = list(sample.options.slice(0, 3), { total: 412, limit: 3, truncated: true })

  it('reports the cap and how many refs it dropped', () => {
    const model = buildPickerModel(capped, '')
    expect(model.truncated).toBe(true)
    expect(model.droppedCount).toBe(409)
  })

  it('still offers a ref that only exists in the dropped tail', () => {
    const model = buildPickerModel(capped, 'origin/release-4.2')
    expect(model.rows.some((row) => row.kind === 'option')).toBe(false)
    expect(model.typed).toEqual({ kind: 'typed', id: TYPED_ROW_ID, ref: 'origin/release-4.2' })
    const choice = commitStartPoint({
      model,
      activeId: defaultActiveId(model),
      query: 'origin/release-4.2',
      open: true
    })
    expect(choice).toEqual({ ref: 'origin/release-4.2', option: null })
  })
})

describe('a failed listing', () => {
  it('keeps the reason and drops the command line in front of it', () => {
    const raw =
      'git for-each-ref --format=%(refname) refs/heads refs/tags exited with code 128: ' +
      'fatal: not a git repository (or any of the parent directories): .git'
    expect(startPointErrorText(raw)).toBe('fatal: not a git repository (or any of the parent directories): .git')
  })

  it('falls back to the first line, capped, when there is no git clause to find', () => {
    expect(startPointErrorText('the runtime went away\nstack trace here')).toBe('the runtime went away')
    expect(startPointErrorText('x'.repeat(400))).toHaveLength(140)
  })
})
