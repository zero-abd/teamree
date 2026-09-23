/** @vitest-environment jsdom */

// The patch as somebody actually looks at it.
//
// The parser has its own file and proves the numbers are right. What this
// proves is that they reach the screen — that the panel puts a gutter beside
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
import { render, screen, within } from '@testing-library/react'
import postcss from 'postcss'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeChanges, WorktreeDiff } from '@shared/entities'

// Recorded rather than inert, because half of what this file now proves is
// which method the control calls and with which hunk. It still never resolves:
// nothing on screen here waits on an answer.
const { call } = vi.hoisted(() => ({
  call: vi.fn((_method: string, _params: unknown): Promise<never> => new Promise(() => {}))
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
const { ChangesTab } = await import('./rightPanel/ChangesTab')
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

beforeEach(() => {
  useWorkspaceStore.setState({
    ...INITIAL,
    rightPanelOpen: true,
    rightPanelTab: 'changes',
    activeWorktreeId: 'wt',
    changes: { wt: changes },
    selectedChangePath: 'src/rank.ts',
    diff,
    diffPending: false,
    stagedPaths: [],
    diffLayout: 'inline'
  })
  window.localStorage.clear()
  call.mockClear()
})

describe('the patch in the changes panel', () => {
  it('puts a line number beside every line, on both sides', () => {
    render(<ChangesTab />)

    const numbers = [...document.querySelectorAll('.patch__num')].map((cell) => cell.textContent)
    // Old and new for each of the six lines the hunk carries, with the addition
    // holding no number on the old side.
    expect(numbers).toEqual(['210', '210', '211', '211', '212', '212', '', '213', '213', '214', '214', '215'])
  })

  // The sentence this whole change is for: the third line of the hunk is line
  // 212, and the screen has to be able to say so.
  it('gives the line somebody would cite its real number', () => {
    render(<ChangesTab />)

    const row = [...document.querySelectorAll('.patch__row')].find((node) =>
      node.textContent?.includes('// one comment')
    )
    expect(within(row as HTMLElement).getAllByText('212')).toHaveLength(2)
  })

  it('shows the hunk header as its own separator, not as a line of the file', () => {
    render(<ChangesTab />)

    const header = document.querySelector('.patch__hunkAt')
    expect(header?.textContent).toBe('@@ -210,6 +210,7 @@ export function rank(rows: Row[]): Row[] {')
    expect(header?.querySelector('.patch__num')).toBeNull()
  })

  it('folds a file away, and folds a hunk away inside it', () => {
    render(<ChangesTab />)

    expect(document.querySelector('details.patch__file')).not.toBeNull()
    expect(document.querySelector('details.patch__hunk')).not.toBeNull()
  })

  // Nothing about the colour is asserted beyond this: that the keyword came
  // back as a keyword and reached the DOM as its own span. Which shade of
  // magenta it is is the palette's business, and the smoke gate measures it.
  it('colours the code it recognises, and leaves the rest as text', () => {
    render(<ChangesTab />)

    const keywords = [...document.querySelectorAll('.patch__tok--keyword')].map((node) => node.textContent)
    expect(keywords).toContain('const')
    expect(keywords).toContain('return')
    expect([...document.querySelectorAll('.patch__tok--comment')].map((node) => node.textContent)).toContain(
      '// one comment'
    )
  })

  it('lays the patch out in two columns when asked, and remembers it', async () => {
    const { rerender } = render(<ChangesTab />)
    expect(document.querySelector('.patch--inline')).not.toBeNull()

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    rerender(<ChangesTab />)

    expect(document.querySelector('.patch--split')).not.toBeNull()
    // Every row has both sides, and the addition's old half is the gap.
    expect(document.querySelectorAll('.patch__side--gap')).toHaveLength(1)
    // And the part that outlives the window: the next launch reads this back.
    expect(readStoredDiffLayout(window.localStorage)).toBe('split')
  })
})

describe('staging one hunk from the patch', () => {
  it('stages the hunk that was clicked, and not the one above it', async () => {
    useWorkspaceStore.setState({ diff: { ...diff, patch: TWO_HUNKS } })
    render(<ChangesTab />)

    const stage = screen.getAllByRole('button', { name: 'Stage' })
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
    const sent = call.mock.calls[0]?.[1] as unknown as { hunk: { lines: { text: string }[] } }
    expect(sent.hunk.lines.map((line) => line.text)).toContain('  const capped = sorted.slice(0, 20)')
    expect(sent.hunk.lines.map((line) => line.text)).not.toContain("import { Row } from './row'")
  })

  // Folding the hunk away is the one thing a click on a `summary` does by
  // default, and it is not what the button is for.
  it('leaves the hunk open when its control is used', async () => {
    render(<ChangesTab />)
    const hunk = document.querySelector('details.patch__hunk') as HTMLDetailsElement
    expect(hunk.open).toBe(true)

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Stage' }))

    expect(hunk.open).toBe(true)
  })

  it('offers Unstage on the staged half and Stage on the working one', async () => {
    useWorkspaceStore.setState({ stagedDiff })
    render(<ChangesTab />)

    expect(screen.getByRole('button', { name: 'Unstage' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stage' })).toBeTruthy()
    // Both halves are named once there are two of them.
    expect([...document.querySelectorAll('.changes__half')].map((node) => node.textContent)).toEqual([
      'Staged',
      'Unstaged'
    ])

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Unstage' }))
    expect(call).toHaveBeenCalledWith('worktree.unstageHunk', expect.objectContaining({ path: 'src/rank.ts' }))
  })

  it('names neither half when nothing is staged', () => {
    render(<ChangesTab />)
    expect(document.querySelectorAll('.changes__half')).toHaveLength(0)
  })

  it('stops a second click while the first is still in flight', async () => {
    render(<ChangesTab />)
    const { default: userEvent } = await import('@testing-library/user-event')
    const button = screen.getByRole('button', { name: 'Stage' })

    await userEvent.click(button)
    await userEvent.click(button)

    expect(call.mock.calls.filter((one) => one[0] === 'worktree.stageHunk')).toHaveLength(1)
  })
})

describe('discarding one hunk from the patch', () => {
  it('offers Discard beside Stage on the working half only', () => {
    useWorkspaceStore.setState({ stagedDiff })
    render(<ChangesTab />)

    const stage = screen.getByRole('button', { name: 'Stage' })
    const discard = screen.getByRole('button', { name: 'Discard' })
    expect(discard.parentElement).toBe(stage.parentElement)
    expect(screen.getAllByRole('button', { name: 'Discard' })).toHaveLength(1)
  })

  it('asks first, then reverses the hunk that was clicked', async () => {
    useWorkspaceStore.setState({ diff: { ...diff, patch: TWO_HUNKS } })
    render(<ChangesTab />)
    const { default: userEvent } = await import('@testing-library/user-event')

    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[1] as HTMLElement)
    expect(call).not.toHaveBeenCalled()
    const dialog = useWorkspaceStore.getState().dialog
    expect(dialog).toMatchObject({ kind: 'confirm-discard', worktreeId: 'wt', path: 'src/rank.ts' })

    render(<ConfirmDiscardDialog {...(dialog as ConfirmDiscardProps)} />)
    expect(screen.getByRole('dialog', { name: 'Discard this hunk of src/rank.ts?' })).toBeTruthy()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard' }))

    expect(call).toHaveBeenCalledWith('worktree.discardHunk', {
      worktreeId: 'wt',
      path: 'src/rank.ts',
      hunk: expect.objectContaining({ oldStart: 210, oldCount: 6, newStart: 210, newCount: 7 })
    })
  })

  // An added or deleted file's patch is the whole file; that goes as a file, not a hunk.
  it('offers no hunk discard for a file that was added', () => {
    useWorkspaceStore.setState({
      diff: {
        ...diff,
        patch: 'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n'
      }
    })
    render(<ChangesTab />)
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  })
})

// The stylesheet's half of the same two claims.
describe('the rules the patch is drawn with', () => {
  const css = postcss.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles/workspace.css'), 'utf8')
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
    expect(declarations('.changes__diff', 'overflow')).toContain('auto')
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
