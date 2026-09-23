/** @vitest-environment jsdom */

// When the palette reaches a pane, relative to when it reaches the chrome.
//
// This is an ordering test and it is here because the ordering was wrong, in a
// way no other test in the repo could see. xterm cannot read CSS, so both
// emulator views re-read the custom properties off the root element in an
// effect of their own whenever the appearance changes; `App` writes those
// properties in an effect of its own. React flushes passive effects child-first
// — a parent's `useEffect` runs *after* every child's — so with two passive
// effects the panes read the palette `App` had not written yet and repainted
// themselves in the theme before last. Switching theme moved the sidebar, the
// title strip and the dialogs, and left every terminal the colour it was.
//
// Both existing tests of that seam pass either way, and that is the point:
// `terminalTheme.test.ts` calls the reader against an element it wrote itself,
// and `WatchedPaneView.test.tsx` calls `applyPalette` by hand before it moves
// the store, because neither has an `App` above it to do that. Nothing short of
// mounting a writer over a reader can tell the two orderings apart.
//
// jsdom has no cascade, so what this measures is the ordering and not the
// cascade: the value the reader sees comes from the inline properties the
// writer set, which is exactly the mechanism `applyPalette` uses. A real
// Chromium would resolve `tokens.css` underneath them as well.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useEffect, useLayoutEffect, useState } from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, resolvePalette, type Appearance } from '@shared/theme'
import { readTerminalTheme } from '../terminal/terminalTheme'
import { applyPalette } from './applyPalette'

const MIDNIGHT: Appearance = { ...DEFAULT_APPEARANCE, themeId: 'midnight' }

/**
 * A writer over a reader, wired the way the app wires them.
 *
 * The reader always uses a passive effect, because that is what both emulator
 * views have and what neither of them should have to change; which hook the
 * writer uses is the variable, so the two orderings can be measured against one
 * another rather than one of them merely asserted.
 */
function mountWriterOverReader(writeWith: typeof useEffect): {
  grounds: string[]
  switchTheme: () => void
} {
  const grounds: string[] = []
  let setTheme = (_appearance: Appearance): void => {}

  function Reader({ appearance }: { appearance: Appearance }): React.JSX.Element {
    useEffect(() => {
      grounds.push(readTerminalTheme(document.documentElement).background as string)
    }, [appearance])
    return <span />
  }

  function Writer(): React.JSX.Element {
    const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE)
    setTheme = setAppearance
    writeWith(() => {
      applyPalette(document.documentElement, resolvePalette(appearance))
    }, [appearance])
    return <Reader appearance={appearance} />
  }

  render(<Writer />)
  return {
    grounds,
    switchTheme: () =>
      act(() => {
        setTheme(MIDNIGHT)
      })
  }
}

describe('the palette, on its way from the appearance to an emulator', () => {
  it('is on the root element before any pane reads it back', () => {
    const { grounds, switchTheme } = mountWriterOverReader(useLayoutEffect)

    // The mount, which has to be the default theme and not the reader's own
    // fallback. The two agree on this token, so it is the switch that carries
    // the weight; this is here so a reader that read nothing at all would not
    // look like a pass.
    expect(grounds).toEqual([resolvePalette(DEFAULT_APPEARANCE)['term-bg']])

    switchTheme()

    // The read that used to answer with the previous theme's ground.
    expect(grounds).toEqual([resolvePalette(DEFAULT_APPEARANCE)['term-bg'], resolvePalette(MIDNIGHT)['term-bg']])
  })

  // The failure this guards against, stated as the thing that produces it, so
  // that anybody who changes the effect in `App` back sees what it costs rather
  // than a test failing about something they did not think they had touched.
  it('is one theme behind when that write is a passive effect instead', () => {
    const { grounds, switchTheme } = mountWriterOverReader(useEffect)
    switchTheme()

    expect(grounds.at(-1)).toBe(resolvePalette(DEFAULT_APPEARANCE)['term-bg'])
    expect(grounds.at(-1)).not.toBe(resolvePalette(MIDNIGHT)['term-bg'])
  })

  // The two cases above measure the orderings against each other on a harness of
  // their own, which is what makes the difference visible at all — but a harness
  // is not `App`, and reverting the one line that matters leaves both of them
  // green. So the line itself is the last assertion, read off the source the way
  // `stylesheets.test.ts` reads the stylesheets and `mac-file-list.test.ts` reads
  // the packaging config: where the behaviour cannot be exercised, the file is
  // the thing to check.
  it('is written by a layout effect in App, which is where it has to be', () => {
    const app = readFileSync(join(import.meta.dirname, '..', 'App.tsx'), 'utf8')
    const write = /(useEffect|useLayoutEffect)\(\(\) => \{\s*applyPalette\(/.exec(app)

    expect(write, 'App.tsx no longer writes the palette in an effect of its own').not.toBeNull()
    expect(
      (write as RegExpExecArray)[1],
      'App.tsx writes the palette in a passive effect, so every pane reads it one theme behind'
    ).toBe('useLayoutEffect')
  })
})

describe('the tone the root element declares', () => {
  it('follows the palette, so scrollbars and form controls match the ground', () => {
    const root = document.createElement('div')
    applyPalette(root, resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'light' }))
    expect(root.style.colorScheme).toBe('light')
    expect(root.dataset.tone).toBe('light')

    applyPalette(root, resolvePalette({ ...DEFAULT_APPEARANCE, mode: 'dark' }))
    expect(root.style.colorScheme).toBe('dark')
    expect(root.dataset.tone).toBe('dark')
  })
})
