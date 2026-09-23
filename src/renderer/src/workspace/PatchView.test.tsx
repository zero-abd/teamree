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

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { ChangesPanel } = await import('./ChangesPanel')
const { readStoredDiffLayout } = await import('../state/preferences')

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

beforeEach(() => {
  useWorkspaceStore.setState({
    ...INITIAL,
    changesOpen: true,
    activeWorktreeId: 'wt',
    changes: { wt: changes },
    selectedChangePath: 'src/rank.ts',
    diff,
    diffPending: false,
    stagedPaths: [],
    diffLayout: 'inline'
  })
  window.localStorage.clear()
})

describe('the patch in the changes panel', () => {
  it('puts a line number beside every line, on both sides', () => {
    render(<ChangesPanel />)

    const numbers = [...document.querySelectorAll('.patch__num')].map((cell) => cell.textContent)
    // Old and new for each of the six lines the hunk carries, with the addition
    // holding no number on the old side.
    expect(numbers).toEqual(['210', '210', '211', '211', '212', '212', '', '213', '213', '214', '214', '215'])
  })

  // The sentence this whole change is for: the third line of the hunk is line
  // 212, and the screen has to be able to say so.
  it('gives the line somebody would cite its real number', () => {
    render(<ChangesPanel />)

    const row = [...document.querySelectorAll('.patch__row')].find((node) =>
      node.textContent?.includes('// one comment')
    )
    expect(within(row as HTMLElement).getAllByText('212')).toHaveLength(2)
  })

  it('shows the hunk header as its own separator, not as a line of the file', () => {
    render(<ChangesPanel />)

    const header = document.querySelector('.patch__hunkHead')
    expect(header?.textContent).toBe('@@ -210,6 +210,7 @@ export function rank(rows: Row[]): Row[] {')
    expect(header?.querySelector('.patch__num')).toBeNull()
  })

  it('folds a file away, and folds a hunk away inside it', () => {
    render(<ChangesPanel />)

    expect(document.querySelector('details.patch__file')).not.toBeNull()
    expect(document.querySelector('details.patch__hunk')).not.toBeNull()
  })

  // Nothing about the colour is asserted beyond this: that the keyword came
  // back as a keyword and reached the DOM as its own span. Which shade of
  // magenta it is is the palette's business, and the smoke gate measures it.
  it('colours the code it recognises, and leaves the rest as text', () => {
    render(<ChangesPanel />)

    const keywords = [...document.querySelectorAll('.patch__tok--keyword')].map((node) => node.textContent)
    expect(keywords).toContain('const')
    expect(keywords).toContain('return')
    expect([...document.querySelectorAll('.patch__tok--comment')].map((node) => node.textContent)).toContain(
      '// one comment'
    )
  })

  it('lays the patch out in two columns when asked, and remembers it', async () => {
    const { rerender } = render(<ChangesPanel />)
    expect(document.querySelector('.patch--inline')).not.toBeNull()

    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    rerender(<ChangesPanel />)

    expect(document.querySelector('.patch--split')).not.toBeNull()
    // Every row has both sides, and the addition's old half is the gap.
    expect(document.querySelectorAll('.patch__side--gap')).toHaveLength(1)
    // And the part that outlives the window: the next launch reads this back.
    expect(readStoredDiffLayout(window.localStorage)).toBe('split')
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
