import { describe, expect, it } from 'vitest'
import type { DotTone } from '../sidebar/agentRows'
import { fileItem, type PaletteItem } from './paletteModel'
import { highlight, rowIcon, rowStatus } from './paletteRow'

const marked = (label: string, query: string): string =>
  highlight(label, query)
    .map((part) => (part.match ? `[${part.text}]` : part.text))
    .join('')

describe('the part of a label the query matched', () => {
  it('marks the whole query where it starts a word, before an earlier run inside one', () => {
    expect(marked('payment retries', 'pay')).toBe('[pay]ment retries')
    expect(marked('webhook payload backoff', 'pay')).toBe('webhook [pay]load backoff')
    expect(marked('repay the payload', 'pay')).toBe('repay the [pay]load')
    expect(marked('New task in payment retries', 'PAY')).toBe('New task in [pay]ment retries')
  })

  it('marks each word on its own when the query is not one run', () => {
    expect(marked('Copy Branch', 'branch copy')).toBe('[Copy] [Branch]')
  })

  it('marks initials for a query that matched them', () => {
    expect(marked('New Worktree', 'nw')).toBe('[N]ew [W]orktree')
  })

  it('marks nothing for an empty query or one found only in hidden keywords', () => {
    expect(marked('Copy Path', '  ')).toBe('Copy Path')
    expect(marked('Copy Path', 'clipboard')).toBe('Copy Path')
  })

  it('keeps every character, so the label reads the same', () => {
    for (const query of ['pa', 'a', 'retries pay', 'zz']) {
      expect(
        highlight('payment retries', query)
          .map((part) => part.text)
          .join('')
      ).toBe('payment retries')
    }
  })
})

describe('a row’s icon', () => {
  const action = (id: string): PaletteItem => ({ kind: 'action', id: id as never, label: id, hint: '', detail: '', search: id })

  it('draws a worktree as a folder, a file as a file, and an agent pane as its glyph', () => {
    expect(rowIcon({ kind: 'worktree', id: 'w1', label: 'a', hint: '', detail: '', search: '' })).toEqual({
      icon: 'folder'
    })
    expect(rowIcon(fileItem('src/pay/charge.ts'))).toEqual({ icon: 'file' })
    expect(
      rowIcon({
        kind: 'pane',
        id: 't1',
        worktreeId: 'w1',
        label: 'x',
        hint: '',
        detail: '',
        search: '',
        tone: 'idle',
        activeAt: 0,
        agent: 'claude'
      })
    ).toEqual({ agent: 'claude' })
    expect(
      rowIcon({ kind: 'pane', id: 't1', worktreeId: 'w1', label: 'x', hint: '', detail: '', search: '', tone: 'idle', activeAt: 0 })
    ).toEqual({ icon: 'terminal' })
  })

  it('gives each command family its own icon, and the rest one neutral mark', () => {
    expect(rowIcon(action('new-worktree'))).toEqual({ icon: 'new-task' })
    expect(rowIcon(action('new-task:rate limits'))).toEqual({ icon: 'new-task' })
    expect(rowIcon(action('setting:Copy on Select'))).toEqual({ icon: 'settings' })
    expect(rowIcon(action('run:dev'))).toEqual({ icon: 'play' })
    expect(rowIcon(action('stop-run:test'))).toEqual({ icon: 'stop' })
    expect(rowIcon(action('theme:studio'))).toEqual({ icon: 'appearance' })
    expect(rowIcon(action('focus-next-pane'))).toEqual({ icon: 'chevron-right' })
  })
})

describe('a row’s status and project', () => {
  const worktree = (detail: string, tone?: DotTone): PaletteItem => ({
    kind: 'worktree',
    id: 'w1',
    label: 'payment retries',
    hint: '',
    detail,
    search: '',
    ...(tone === undefined ? {} : { tone })
  })

  it('lifts a said state out of the detail into the status, and keeps the rest', () => {
    expect(rowStatus(worktree('shop · asking', 'waiting'))).toEqual({ tone: 'waiting', word: 'asking', meta: 'shop' })
    expect(rowStatus(worktree('shop · working · current', 'working'))).toEqual({
      tone: 'working',
      word: 'working',
      meta: 'shop · current'
    })
  })

  it('keeps the dot alone for a state the row does not say', () => {
    expect(rowStatus(worktree('shop', 'quiet'))).toEqual({ tone: 'quiet', word: null, meta: 'shop' })
    expect(rowStatus(worktree('shop'))).toEqual({ tone: null, word: null, meta: 'shop' })
  })

  it('leaves a command’s hint as it was', () => {
    expect(
      rowStatus({ kind: 'action', id: 'new-worktree', label: 'New Task…', hint: '⌘N', detail: '', search: '' })
    ).toEqual({ tone: null, word: null, meta: '⌘N' })
  })
})
