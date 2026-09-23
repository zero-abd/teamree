/** @vitest-environment jsdom */

// The start-from control, as a screen reader and a keyboard meet it.
//
// `startPointModel.test.ts` already settles what each query leaves, where an
// arrow lands and what a row submits. None of that is what breaks here. What
// breaks here is the wiring: an `aria-activedescendant` naming an element that
// is not on the page, a pick that loses the sha behind the row, a list that
// eats the Enter which should have submitted the form, or a mouse-down that
// closes the popup before the row it is on can be chosen. Those are properties
// of the rendered control and only a rendered control can be asked about them.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { StartPoint, StartPointList } from '@shared/entities'
import { StartPointPicker, type StartPointValue } from './StartPointPicker'
import type { StartPointsState } from './useStartPoints'

const point = (ref: string, overrides: Partial<StartPoint> = {}): StartPoint => ({
  ref,
  kind: 'remoteBranch',
  sha: `${ref.replace(/\W/g, '')}0000000000000000000000000000`.slice(0, 40),
  shortSha: `${ref.replace(/\W/g, '')}000000`.slice(0, 7),
  refName: ref,
  isBase: false,
  isCurrent: false,
  updatedAt: 0,
  ...overrides
})

const LIST: StartPointList = {
  baseRef: 'origin/main',
  options: [
    point('origin/main', { isBase: true }),
    point('feature/pager', { kind: 'localBranch', isCurrent: true }),
    point('feature/relay', { kind: 'localBranch' }),
    point('v4.0.0', { kind: 'tag' })
  ],
  total: 4,
  limit: 50,
  truncated: false
}

const ready = (list: StartPointList = LIST): StartPointsState => ({ phase: 'ready', list })

/** Holds the value the way the composer does, so a pick is actually applied. */
function Harness({
  state = ready(),
  initial = { text: '', option: null },
  onReload = () => {},
  branchName = 'rewrite-the-pager',
  onChange
}: {
  state?: StartPointsState
  initial?: StartPointValue
  onReload?: () => void
  branchName?: string
  onChange?: (value: StartPointValue) => void
}): React.JSX.Element {
  const [value, setValue] = useState<StartPointValue>(initial)
  return (
    <StartPointPicker
      state={state}
      onReload={onReload}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      branchName={branchName}
    />
  )
}

const box = (): HTMLInputElement => screen.getByRole('combobox', { name: 'Start from' })

/** The row `aria-activedescendant` points at — resolved through the DOM, so a
 *  highlight that names a node which is not there fails rather than passes. */
function highlighted(): HTMLElement | null {
  const id = box().getAttribute('aria-activedescendant')
  return id === null ? null : document.getElementById(id)
}

const rowText = (row: HTMLElement | null): string => row?.textContent ?? ''

describe('the combobox contract', () => {
  it('is an editable combobox with a list, closed until it is asked for', () => {
    render(<Harness />)
    expect(box().getAttribute('aria-expanded')).toBe('false')
    expect(box().getAttribute('aria-autocomplete')).toBe('list')
    expect(box().getAttribute('aria-activedescendant')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('names a listbox that is actually on the page once it opens', () => {
    render(<Harness />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const listbox = screen.getByRole('listbox', { name: 'Start points' })
    expect(box().getAttribute('aria-expanded')).toBe('true')
    expect(box().getAttribute('aria-controls')).toBe(listbox.id)
  })

  // The whole reason focus never leaves the input: the highlight is carried by
  // this attribute, and an id that resolves to nothing is a screen reader
  // announcing silence while the eye follows a moving bar.
  it('keeps the highlight pointing at a real option, and marks only that one selected', () => {
    render(<Harness />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const row = highlighted()
    expect(row).not.toBeNull()
    expect(row?.getAttribute('role')).toBe('option')
    expect(row?.getAttribute('aria-selected')).toBe('true')
    const selected = screen.getAllByRole('option').filter((node) => node.getAttribute('aria-selected') === 'true')
    expect(selected).toEqual([row])
  })

  it('describes the box with the line that says what will be branched', () => {
    render(<Harness initial={{ text: 'origin/main', option: LIST.options[0] ?? null }} />)
    const description = document.getElementById(box().getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toContain('rewrite-the-pager')
    expect(description?.textContent).toContain('origin/main')
  })

  it('groups the rows under headings a reader can use', () => {
    render(<Harness />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const groups = screen.getAllByRole('group')
    expect(groups.map((group) => group.textContent?.split(/(?=[A-Zov])/)[0])).not.toHaveLength(0)
    expect(screen.getByText('Base ref')).toBeTruthy()
    expect(screen.getByText('Local branches')).toBeTruthy()
    expect(screen.getByText('Tags')).toBeTruthy()
  })
})

describe('walking the list with the keyboard', () => {
  it('opens on the first row going down and the last going up', () => {
    render(<Harness />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(rowText(highlighted())).toContain('origin/main')

    fireEvent.keyDown(box(), { key: 'Escape' })
    render(<Harness />)
    const second = screen.getAllByRole('combobox')[1] as HTMLInputElement
    fireEvent.keyDown(second, { key: 'ArrowUp' })
    expect(second.getAttribute('aria-expanded')).toBe('true')
  })

  it('moves one row at a time and wraps at the end', () => {
    render(<Harness />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(rowText(highlighted())).toContain('feature/pager')
    for (let i = 0; i < 3; i++) fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(rowText(highlighted())).toContain('origin/main')
  })

  // Opening a prefilled box on the top of the list would silently move the
  // choice already made to whatever happens to be first.
  it('opens on the row already in the box, not on the top of the list', () => {
    render(<Harness initial={{ text: 'v4.0.0', option: LIST.options[3] ?? null }} />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(rowText(highlighted())).toContain('v4.0.0')
  })

  it('commits the highlighted row, with its sha, and closes', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ text: 'feature/pager', option: LIST.options[1] })
    expect(box().value).toBe('feature/pager')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  // The list swallowing Enter is right; swallowing it once closed would leave
  // the dialog with no way to submit from the field somebody finished in.
  it('swallows Enter only while the list is open', () => {
    render(<Harness />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false)
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true)
  })

  it('lets Tab out of the list rather than trapping it', () => {
    render(<Harness />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(fireEvent.keyDown(box(), { key: 'Tab' })).toBe(true)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('a ref the listing never mentioned', () => {
  it('is offered as a row of its own, and submits exactly as typed', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(box(), { target: { value: '4f9a1c2' } })
    expect(screen.getByText('use as typed')).toBeTruthy()
    const typed = screen.getAllByRole('option')[0] as HTMLElement
    fireEvent.mouseDown(typed)
    expect(onChange).toHaveBeenLastCalledWith({ text: '4f9a1c2', option: null })
  })

  it('says git will resolve it, rather than inventing a sha for it', () => {
    render(<Harness initial={{ text: '4f9a1c2', option: null }} />)
    const description = document.getElementById(box().getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toContain('(resolved on create)')
  })

  // Typing a listed ref in full is the same choice as picking it, so it has to
  // carry the same sha — otherwise the summary is precise for a mouse and
  // vague for a keyboard.
  it('adopts the listed row’s sha when the typed text names one exactly', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(box(), { target: { value: 'feature/relay' } })
    expect(onChange).toHaveBeenLastCalledWith({ text: 'feature/relay', option: LIST.options[2] })
  })

  // A query that matches no ref is never a dead end: the text itself is still
  // a row, because the ref somebody wants may be a sha or may sit in the tail
  // the runtime dropped.
  it('leaves the typed text on offer when it matches no listed ref', () => {
    render(<Harness />)
    fireEvent.change(box(), { target: { value: 'zzz' } })
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('zzz')
    expect(rows[0]?.textContent).toContain('use as typed')
  })

  // NB: the popup's "No matches" only ever appears for a repository
  // whose listing is empty — with any text in the box the typed row is itself a
  // row, so the count is never zero. See the note in the agent's report.
  it('says there is nothing to pick when the listing itself is empty', () => {
    render(<Harness state={ready({ ...LIST, options: [], total: 0 })} />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('names how many refs the cap dropped, so the tail is reachable', () => {
    render(<Harness state={ready({ ...LIST, total: 900, limit: 4, truncated: true })} />)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(screen.getByText(/First 4 of 900 refs/)).toBeTruthy()
    expect(screen.getByText(/other\s*896/)).toBeTruthy()
  })
})

describe('picking with the mouse', () => {
  // The input's blur closes the list. A row that waited for `click` would be
  // gone by the time the click landed, so every pick has to happen on
  // mouse-down with the default prevented.
  it('chooses the row under the pointer without the blur beating it', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    act(() => box().focus())
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const row = screen.getAllByRole('option').find((node) => node.textContent?.includes('v4.0.0')) as HTMLElement
    const prevented = !fireEvent.mouseDown(row)
    expect(prevented).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith({ text: 'v4.0.0', option: LIST.options[3] })
  })

  it('opens and closes from the toggle, and says which it will do', () => {
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Show refs' })
    fireEvent.mouseDown(toggle)
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(document.activeElement).toBe(box())
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Hide refs' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps the toggle out of the tab order, because the input already opens the list', () => {
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Show refs' }).getAttribute('tabindex')).toBe('-1')
  })
})

describe('when the refs cannot be listed', () => {
  it('says it is reading, rather than presenting an empty repository', () => {
    render(<Harness state={{ phase: 'loading' }} />)
    expect(screen.getByText(/Reading the repository.s refs/)).toBeTruthy()
  })

  // A failed listing is not fatal — a ref typed by hand still works — so the
  // hint has to say that instead of leaving somebody staring at a dead field.
  it('names the reason, keeps the box usable, and offers the read again', () => {
    const onReload = vi.fn()
    render(
      <Harness
        state={{
          phase: 'error',
          message:
            'git for-each-ref --format=... : fatal: not a git repository (or any of the parent directories): .git'
        }}
        onReload={onReload}
      />
    )
    expect(screen.getByText(/fatal: not a git repository/)).toBeTruthy()
    expect(box().hasAttribute('disabled')).toBe(false)
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(onReload).toHaveBeenCalledOnce()
  })

  it('still accepts and reports a ref typed while the listing is broken', () => {
    const onChange = vi.fn()
    render(<Harness state={{ phase: 'error', message: 'fatal: boom' }} onChange={onChange} />)
    fireEvent.change(box(), { target: { value: 'origin/release' } })
    expect(onChange).toHaveBeenLastCalledWith({ text: 'origin/release', option: null })
    expect(within(screen.getByRole('listbox')).getByText('use as typed')).toBeTruthy()
  })

  it('asks for nothing to be picked when the box is empty', () => {
    render(<Harness />)
    const description = document.getElementById(box().getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe('Branch, tag or commit')
  })
})
