/** @vitest-environment jsdom */

// The patch as somebody actually looks at it: a file pane in Diff mode.
//
// The parser has its own file and proves the numbers are right. What this
// proves is that they reach the screen — that the pane puts a gutter beside
// every line rather than a column of `+` and `-`, that the `@@` header is a
// separator of its own rather than a line in the middle of the text, and that
// the choice between one column and two survives the window closing.
//
// Two of these assertions are about a stylesheet, read with a parser rather
// than through `getComputedStyle`: jsdom does not load the app's CSS, so a test
// that asked the element what its `position` was would be told `static` however
// the sheet is written. What can be asserted honestly is that the rule exists
// and says `sticky`, and that the class the component renders is the one it
// applies to.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor, within } from '@testing-library/react'
import postcss from 'postcss'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeChanges, WorktreeDiff } from '@shared/entities'

// Recorded, because half of what this file proves is which method a control
// calls and with which hunk. Only the two diffs are answered; nothing else on
// screen here waits on one.
const { call } = vi.hoisted(() => ({
  call: vi.fn((_method: string, _params: unknown): Promise<unknown> => new Promise(() => {}))
}))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call,
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { FileView } = await import('../files/FileView')
const { fitLayout, PatchView } = await import('./PatchView')
const { readStoredDiffLayout } = await import('../state/preferences')
const { ConfirmDiscardDialog } = await import('../dialogs/ConfirmDiscardDialog')
type ConfirmDiscardProps = Parameters<typeof ConfirmDiscardDialog>[0]

const INITIAL = useWorkspaceStore.getState()

// Real `git diff` output over one file, so the numbers under test are the ones
// git would have produced rather than the ones this test wants to see.
const PATCH = `diff --git a/src/rank.ts b/src/rank.ts
index c9e9e05..ada8efd 100644
--- a/src/rank.ts
+++ b/src/rank.ts
@@ -210,6 +210,7 @@ export function rank(rows: Row[]): Row[] {
   const scored = rows.map(score)
   const sorted = scored.sort(byScore)
   // one comment
+  const capped = sorted.slice(0, 20)
   return sorted
 }
`

const changes: WorktreeChanges = {
  worktreeId: 'wt',
  changes: [{ path: 'src/rank.ts', kind: 'modified', staged: false, unstaged: true }],
  total: 1,
  limit: 50,
  truncated: false,
  readAt: 0
}

const diff: WorktreeDiff = {
  worktreeId: 'wt',
  path: 'src/rank.ts',
  staged: false,
  patch: PATCH,
  truncated: false,
  readAt: 0
}

// Two edits far enough apart to be two hunks, so "the second one" is a thing
// the test can point at. Real `git diff` output again.
const TWO_HUNKS = `diff --git a/src/rank.ts b/src/rank.ts
--- a/src/rank.ts
+++ b/src/rank.ts
@@ -1,3 +1,3 @@
 import { byScore } from './score'
-import { Row } from './row'
+import type { Row } from './row'
 
@@ -210,6 +210,7 @@ export function rank(rows: Row[]): Row[] {
   const scored = rows.map(score)
   const sorted = scored.sort(byScore)
   // one comment
+  const capped = sorted.slice(0, 20)
   return sorted
 }
`

const stagedDiff: WorktreeDiff = {
  worktreeId: 'wt',
  path: 'src/rank.ts',
  staged: true,
  patch: PATCH,
  truncated: false,
  readAt: 0
}

const empty = (staged: boolean): WorktreeDiff => ({ ...diff, staged, patch: '' })

/** The pane's width as the browser would measure it; jsdom lays nothing out. */
let paneWidth = 1000

/** A file pane on src/rank.ts in Diff mode, answering with these two halves. */
async function mountDiff(halves: { working?: WorktreeDiff; staged?: WorktreeDiff } = {}): Promise<void> {
  call.mockImplementation((method: string, params: unknown) => {
    if (method !== 'worktree.diff') return new Promise(() => {})
    const staged = (params as { staged?: boolean }).staged === true
    return Promise.resolve(staged ? (halves.staged ?? empty(true)) : (halves.working ?? diff))
  })
  render(<FileView paneId="file:1" worktreeId="wt" path="src/rank.ts" focused onFocus={() => {}} onClose={() => {}} />)
  await waitFor(() => expect(document.querySelector('.patch')).not.toBeNull())
}

beforeEach(() => {
  useWorkspaceStore.setState({
    ...INITIAL,
    rightPanelOpen: true,
    rightPanelTab: 'changes',
    activeWorktreeId: 'wt',
    changes: { wt: changes },
    selectedChangePath: null,
    diffPanes: { 'file:1': true },
    stagedPaths: [],
    diffLayout: 'inline'
  })
  window.localStorage.clear()
  call.mockReset()
  paneWidth = 1000
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => paneWidth)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the patch in a file pane', () => {
  it('puts a line number beside every line, on both sides', async () => {
    await mountDiff()

    const numbers = [...document.querySelectorAll('.patch__num')].map((cell) => cell.textContent)
    // Old and new for each of the six lines the hunk carries, with the addition
    // holding no number on the old side.
    expect(numbers).toEqual(['210', '210', '211', '211', '212', '212', '', '213', '213', '214', '214', '215'])
  })

  // The sentence this whole change is for: the third line of the hunk is line
  // 212, and the screen has to be able to say so.
  it('gives the line somebody would cite its real number', async () => {
    await mountDiff()

    const row = [...document.querySelectorAll('.patch__row')].find((node) =>
      node.textContent?.includes('// one comment')
    )
    expect(within(row as HTMLElement).getAllByText('212')).toHaveLength(2)
  })

  it('shows the hunk header as its own separator, not as a line of the file', async () => {
    await mountDiff()

    const header = document.querySelector('.patch__hunkAt')
    // The function it is in reads; git's own line is the hover.
    expect(header?.textContent).toBe('export function rank(…)')
    expect(header?.getAttribute('title')).toBe('@@ -210,6 +210,7 @@ export function rank(rows: Row[]): Row[] {')
    expect(header?.querySelector('.patch__num')).toBeNull()
  })

  it('folds a file away, and folds a hunk away inside it', async () => {
    await mountDiff()

    expect(document.querySelector('details.patch__file')).not.toBeNull()
    expect(document.querySelector('details.patch__hunk')).not.toBeNull()
  })

  // Nothing about the colour is asserted beyond this: that the keyword came
  // back as a keyword and reached the DOM as its own span. Which shade of
  // magenta it is is the palette's business, and the smoke gate measures it.
  it('colours the code it recognises, and leaves the rest as text', async () => {
    await mountDiff()

    const keywords = [...document.querySelectorAll('.patch__tok--keyword')].map((node) => node.textContent)
    expect(keywords).toContain('const')
    expect(keywords).toContain('return')
    expect([...document.querySelectorAll('.patch__tok--comment')].map((node) => node.textContent)).toContain(
      '// one comment'
    )
  })

  it('lays the patch out in two columns when asked, and remembers it', async () => {
    await mountDiff()
    expect(document.querySelector('.patch--inline')).not.toBeNull()

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Side by side' }))

    expect(document.querySelector('.patch--split')).not.toBeNull()
    // Every row has both sides, and the addition's old half is the gap.
    expect(document.querySelectorAll('.patch__side--gap')).toHaveLength(1)
    // And the part that outlives the window: the next launch reads this back.
    expect(readStoredDiffLayout(window.localStorage)).toBe('split')
  })
})

describe('side by side', () => {
  it('falls back to inline below the width two columns need', () => {
    expect(fitLayout('split', 719)).toBe('inline')
    expect(fitLayout('split', 720)).toBe('split')
    expect(fitLayout('split', null)).toBe('split')
    expect(fitLayout('inline', 2000)).toBe('inline')
  })

  it('is disabled in a narrow pane, which keeps the remembered choice but draws one column', async () => {
    paneWidth = 500
    useWorkspaceStore.setState({ diffLayout: 'split' })
    await mountDiff()

    expect((screen.getByRole('button', { name: 'Side by side' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Inline' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.patch--inline')).not.toBeNull()
    expect(useWorkspaceStore.getState().diffLayout).toBe('split')
  })
})

describe('staging one hunk from the patch', () => {
  it('stages the hunk that was clicked, and not the one above it', async () => {
    await mountDiff({ working: { ...diff, patch: TWO_HUNKS } })

    const stage = screen.getAllByRole('button', { name: 'Stage Hunk' })
    expect(stage).toHaveLength(2)

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(stage[1] as HTMLElement)

    expect(call).toHaveBeenCalledWith('worktree.stageHunk', {
      worktreeId: 'wt',
      path: 'src/rank.ts',
      hunk: expect.objectContaining({ oldStart: 210, oldCount: 6, newStart: 210, newCount: 7 })
    })
    // The whole hunk goes, lines and all — that is what the runtime checks
    // against the index and the working tree.
    const sent = call.mock.calls.find(([method]) => method === 'worktree.stageHunk')?.[1] as unknown as {
      hunk: { lines: { text: string }[] }
    }
    expect(sent.hunk.lines.map((line) => line.text)).toContain('  const capped = sorted.slice(0, 20)')
    expect(sent.hunk.lines.map((line) => line.text)).not.toContain("import { Row } from './row'")
  })

  // Folding the hunk away is the one thing a click on a `summary` does by
  // default, and it is not what the button is for.
  it('leaves the hunk open when its control is used', async () => {
    await mountDiff()
    const hunk = document.querySelector('details.patch__hunk') as HTMLDetailsElement
    expect(hunk.open).toBe(true)

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Stage Hunk' }))

    expect(hunk.open).toBe(true)
  })

  it('offers Unstage on the staged half and Stage on the working one', async () => {
    await mountDiff({ staged: stagedDiff })

    expect(screen.getByRole('button', { name: 'Unstage Hunk' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stage Hunk' })).toBeTruthy()
    // Both halves are named once there are two of them.
    expect([...document.querySelectorAll('.patch__half')].map((node) => node.textContent)).toEqual([
      'Staged',
      'Unstaged'
    ])

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Unstage Hunk' }))
    expect(call).toHaveBeenCalledWith('worktree.unstageHunk', expect.objectContaining({ path: 'src/rank.ts' }))
  })

  it('names neither half when nothing is staged', async () => {
    await mountDiff()
    expect(document.querySelectorAll('.patch__half')).toHaveLength(0)
  })

  it('stops a second click while the first is still in flight', async () => {
    await mountDiff()
    const { default: userEvent } = await import('@testing-library/user-event')
    const button = screen.getByRole('button', { name: 'Stage Hunk' })

    await userEvent.click(button)
    await userEvent.click(button)

    expect(call.mock.calls.filter((one) => one[0] === 'worktree.stageHunk')).toHaveLength(1)
  })
})

describe('discarding one hunk from the patch', () => {
  it('offers Discard beside Stage on the working half only', async () => {
    await mountDiff({ staged: stagedDiff })

    const stage = screen.getByRole('button', { name: 'Stage Hunk' })
    const discard = screen.getByRole('button', { name: 'Discard' })
    expect(discard.parentElement).toBe(stage.parentElement)
    expect(screen.getAllByRole('button', { name: 'Discard' })).toHaveLength(1)
  })

  it('asks first, then reverses the hunk that was clicked', async () => {
    await mountDiff({ working: { ...diff, patch: TWO_HUNKS } })
    const { default: userEvent } = await import('@testing-library/user-event')

    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[1] as HTMLElement)
    expect(call.mock.calls.some(([method]) => method === 'worktree.discardHunk')).toBe(false)
    const dialog = useWorkspaceStore.getState().dialog
    expect(dialog).toMatchObject({ kind: 'confirm-discard', worktreeId: 'wt', path: 'src/rank.ts' })

    render(<ConfirmDiscardDialog {...(dialog as ConfirmDiscardProps)} />)
    expect(screen.getByRole('dialog', { name: 'Discard this hunk of src/rank.ts?' })).toBeTruthy()
    // A copy is kept first, so the question says nothing about it being final.
    expect(screen.queryByText(/undone/)).toBeNull()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard' }))

    expect(call).toHaveBeenCalledWith('worktree.discardHunk', {
      worktreeId: 'wt',
      path: 'src/rank.ts',
      hunk: expect.objectContaining({ oldStart: 210, oldCount: 6, newStart: 210, newCount: 7 })
    })
  })

  // An added or deleted file's patch is the whole file; that goes as a file, not a hunk.
  it('offers no hunk discard for a file that was added', async () => {
    await mountDiff({
      working: {
        ...diff,
        patch: 'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n'
      }
    })
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  })
})

/** An added file of `count` lines, as git would write it. */
function addedFile(
  path: string,
  count: number,
  line = (at: number) => `export const entry${at} = { id: ${at} }`
): string {
  const body = Array.from({ length: count }, (_, at) => `+${line(at)}`).join('\n')
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n${body}\n`
}

/** A modified file with `hunks` hunks of `size` added lines each. */
function editedFile(path: string, hunks: number, size: number): string {
  const parts = Array.from({ length: hunks }, (_, at) => {
    const start = at * 1000 + 1
    const lines = Array.from({ length: size }, (_, line) => `+  "k${at}-${line}": "v"`).join('\n')
    return `@@ -${start},1 +${start},${size + 1} @@\n "a${at}",\n${lines}`
  })
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${parts.join('\n')}\n`
}

describe('a big patch', () => {
  it('draws a hunk over 500 lines folded, and all of it when asked', async () => {
    render(<PatchView patch={addedFile('src/big.ts', 14278)} truncated={false} layout="inline" />)

    expect(document.querySelectorAll('.patch__row')).toHaveLength(0)
    expect(document.querySelector('.patch__hunkAt')?.textContent).toBe('Lines 1–14278')
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Show 14,278 lines' }))

    // The top at once, the rest behind it.
    const first = document.querySelectorAll('.patch__row').length
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(14278)
    await waitFor(() => expect(document.querySelectorAll('.patch__row')).toHaveLength(14278), { timeout: 20_000 })
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull()
  })

  it('draws a 1 MB added file in under 5,000 elements', () => {
    const { container } = render(<PatchView patch={addedFile('src/big.ts', 14278)} truncated={false} layout="split" />)
    expect(container.querySelectorAll('*').length).toBeLessThan(5000)
  })

  it('draws a hunk of 500 lines whole', () => {
    render(<PatchView patch={addedFile('src/mid.ts', 500)} truncated={false} layout="inline" />)
    const first = document.querySelectorAll('.patch__row').length
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(14278)
  })

  // One line of a minified bundle is as many tokens as a file.
  it('folds a hunk whose lines are few but long', () => {
    render(
      <PatchView patch={addedFile('dist/index.js', 3, () => 'a=1;'.repeat(20000))} truncated={false} layout="inline" />
    )
    expect(document.querySelectorAll('.patch__row')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Show 3 lines' })).toBeTruthy()
  })

  it('stops drawing hunks once the patch has drawn its share, and folds the rest', () => {
    render(<PatchView patch={editedFile('src/wide.ts', 12, 400)} truncated={false} layout="inline" />)
    const shown = document.querySelectorAll('.patch__lines').length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(12)
    expect(screen.getAllByRole('button', { name: 'Show 401 lines' })).toHaveLength(12 - shown)
  })

  it.each([
    'package-lock.json',
    'web/yarn.lock',
    'Cargo.lock',
    'pnpm-lock.yaml',
    'go.sum',
    'public/app.min.js',
    'app.min.css'
  ])('starts %s folded, however small', (path) => {
    render(<PatchView patch={editedFile(path, 1, 2)} truncated={false} layout="inline" />)
    expect(document.querySelectorAll('.patch__row')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Show 3 lines' })).toBeTruthy()
  })

  it('draws a small edit to an ordinary file', () => {
    render(<PatchView patch={editedFile('src/lockstep.ts', 1, 2)} truncated={false} layout="inline" />)
    expect(document.querySelectorAll('.patch__row')).toHaveLength(3)
  })

  it('stages and discards a folded hunk from its header', async () => {
    const onHunk = vi.fn()
    const onDiscard = vi.fn()
    render(
      <PatchView
        patch={editedFile('package-lock.json', 2, 2)}
        truncated={false}
        layout="inline"
        action="Stage Hunk"
        onHunk={onHunk}
        onDiscard={onDiscard}
      />
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getAllByRole('button', { name: 'Stage Hunk' })[1] as HTMLElement)
    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[1] as HTMLElement)

    expect(onHunk).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'package-lock.json' }),
      expect.objectContaining({ oldStart: 1001, newCount: 3 })
    )
    expect(onDiscard).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'package-lock.json' }),
      expect.objectContaining({ oldStart: 1001, newCount: 3 })
    )
    // Folded still: the controls act on the hunk without drawing it.
    expect(document.querySelectorAll('.patch__row')).toHaveLength(0)
  })

  it('keeps a hunk shown across a refresh of the same patch', async () => {
    const patch = addedFile('src/big.ts', 600)
    const { rerender } = render(<PatchView patch={patch} truncated={false} layout="inline" />)
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Show 600 lines' }))

    rerender(<PatchView patch={`${patch}`} truncated={false} layout="split" />)
    await waitFor(() => expect(document.querySelectorAll('.patch__row')).toHaveLength(600))
  })

  it('leaves focus on the hunk it unfolded', async () => {
    render(<PatchView patch={addedFile('src/big.ts', 600)} truncated={false} layout="inline" />)
    const { default: userEvent } = await import('@testing-library/user-event')
    screen.getByRole('button', { name: 'Show 600 lines' }).focus()
    await userEvent.keyboard('{Enter}')

    expect(document.activeElement?.className).toBe('patch__hunkHead')
  })
})

describe('finding in the diff', () => {
  // jsdom lays nothing out, and has no box for a range at all.
  beforeEach(() => {
    Range.prototype.getBoundingClientRect = () => new DOMRect()
  })

  /** A file pane in Diff mode on a lockfile, whose two hunks open folded, with its find bar up. */
  async function mountFind(onCloseSearch = (): void => {}): Promise<void> {
    const working = { ...diff, path: 'package-lock.json', patch: editedFile('package-lock.json', 2, 2) }
    call.mockImplementation((method: string, params: unknown) => {
      if (method !== 'worktree.diff') return new Promise(() => {})
      return Promise.resolve((params as { staged?: boolean }).staged === true ? empty(true) : working)
    })
    render(
      <FileView
        paneId="file:1"
        worktreeId="wt"
        path="package-lock.json"
        focused
        onFocus={() => {}}
        onClose={() => {}}
        searchToken={1}
        onCloseSearch={onCloseSearch}
      />
    )
    await waitFor(() => expect(document.querySelector('.patch')).not.toBeNull())
  }

  const count = (): string | null => screen.getByRole('status').textContent

  it('finds a line inside a folded hunk and unfolds that hunk alone', async () => {
    await mountFind()
    expect(screen.getAllByRole('button', { name: 'Show 3 lines' })).toHaveLength(2)
    const { default: userEvent } = await import('@testing-library/user-event')
    // Pasted: typed, each prefix would land on a first match of its own.
    await userEvent.click(screen.getByRole('textbox', { name: 'Find in pane' }))
    await userEvent.paste('k1-1')

    expect(count()).toBe('1 of 1')
    expect(screen.getAllByRole('button', { name: 'Show 3 lines' })).toHaveLength(1)
    const row = [...document.querySelectorAll('.patch__row')].find((node) => node.textContent?.includes('"k1-1"'))
    expect(row).toBeTruthy()
  })

  it('steps with Return and Shift+Return, round the ends', async () => {
    await mountFind()
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.type(screen.getByRole('textbox', { name: 'Find in pane' }), '"v"')
    expect(count()).toBe('1 of 4')

    await userEvent.keyboard('{Enter}{Enter}')
    expect(count()).toBe('3 of 4')
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull()
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(count()).toBe('2 of 4')
    await userEvent.keyboard('{Enter}{Enter}{Enter}')
    expect(count()).toBe('1 of 4')
  })

  it('closes on Escape and hands the keyboard back to the diff', async () => {
    const onCloseSearch = vi.fn()
    await mountFind(onCloseSearch)
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.type(screen.getByRole('textbox', { name: 'Find in pane' }), 'k0{Escape}')

    expect(onCloseSearch).toHaveBeenCalledOnce()
    expect(document.activeElement?.classList.contains('file__diff')).toBe(true)
  })
})

// The stylesheet's half of the same two claims.
describe('the rules the patch is drawn with', () => {
  const styles = path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles')
  const css = postcss.parse(
    ['workspace.css', 'files.css'].map((file) => readFileSync(path.join(styles, file), 'utf8')).join('\n')
  )

  const declarations = (selector: string, property: string): string[] => {
    const found: string[] = []
    css.walkRules((rule) => {
      if (!rule.selector.split(',').some((one) => one.trim() === selector)) return
      rule.walkDecls(property, (decl) => {
        found.push(decl.value)
      })
    })
    return found
  }

  it('sticks the hunk header to the top of the area the patch scrolls in', () => {
    expect(declarations('.patch__hunkHead', 'position')).toContain('sticky')
    expect(declarations('.patch__hunkHead', 'top')).toContain('0')
    expect(declarations('.file__diff', 'overflow')).toContain('auto')
  })

  // A long line widens the patch; the headers stay the scroller's width, pinned to its left edge,
  // so Stage, Unstage and Discard never sit past its right edge.
  it('pins the headers and their controls to the width on screen', () => {
    for (const head of ['.patch__hunkHead', '.patch__fileHead']) {
      expect(declarations(head, 'position')).toContain('sticky')
      expect(declarations(head, 'left')).toContain('0')
      expect(declarations(head, 'width')).toContain('100cqi')
    }
    expect(declarations('.file__diff', 'container-type')).toContain('inline-size')
  })

  // No literal colours: every shade on this surface has to be a palette token,
  // which is what lets the smoke gate's contrast measurement mean anything and
  // what makes a theme switch carry the patch with it.
  it('names a token for every colour on the patch', () => {
    const literals: string[] = []
    css.walkRules((rule) => {
      if (!rule.selector.includes('patch')) return
      rule.walkDecls((decl) => {
        if (/#[0-9a-f]{3,8}\b|\brgba?\(/i.test(decl.value)) literals.push(`${rule.selector}: ${decl.value}`)
      })
    })
    expect(literals).toEqual([])
  })
})
