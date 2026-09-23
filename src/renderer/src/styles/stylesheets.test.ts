// Every stylesheet has to parse.
//
// This exists because one did not, and nothing noticed. A rule lost its body
// during a merge — the opening brace ended up with the next block's comment
// after it instead of its own declarations — and typecheck, lint, the
// formatter and eight hundred tests all passed, because not one of them reads
// CSS. The renderer build was the first thing to object, which is to say the
// break was invisible until somebody tried to run the app.
//
// A stylesheet is the one kind of source in this repo with no compiler in
// front of it, so it gets this instead.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, resolvePalette, THEME_TOKENS } from '@shared/theme'

const here = path.dirname(fileURLToPath(import.meta.url))
const sheets = readdirSync(here)
  .filter((name) => name.endsWith('.css'))
  .sort()

describe('stylesheets', () => {
  // If this ever finds nothing, the check has silently stopped checking.
  it('finds the stylesheets to check', () => {
    expect(sheets.length).toBeGreaterThan(5)
  })

  it.each(sheets)('%s parses', (name) => {
    const css = readFileSync(path.join(here, name), 'utf8')
    expect(() => postcss.parse(css, { from: name })).not.toThrow()
  })

  // The specific shape of the break that got through: a rule whose body was
  // swallowed, leaving a selector that declares nothing.
  it.each(sheets)('%s has no rule with an empty body', (name) => {
    const css = readFileSync(path.join(here, name), 'utf8')
    const empty: string[] = []
    postcss.parse(css, { from: name }).walkRules((rule) => {
      if (rule.nodes.length === 0) empty.push(rule.selector)
    })
    expect(empty).toEqual([])
  })

  // Errors raised by a dialog are notices, and a notice under the modal scrim
  // is painted and then covered: the dialog stays open, the button goes live
  // again, and nothing appears. The two numbers live in two files, so the
  // relationship is asserted here rather than a literal in either of them.
  it('stacks the notices above the modal layer, so no dialog can hide its own error', () => {
    expect(zIndexOf('.notices')).toBeGreaterThan(zIndexOf('.modal-layer'))
  })

  // `text-overflow: ellipsis` cuts wherever the box ends, which on a row of
  // monospace is mid-word: "MCP startup incomplete (fai…". A one-line clamp
  // wraps at words first and ellipsises after the last one that fits, which is
  // the only way CSS has of ending a line on a word.
  it('ends a quoted line under a pane row on a word, not in the middle of one', () => {
    const rule = ruleFor('sidebar.css', '.pane-row__evidence')
    expect(declarationOf(rule, '-webkit-line-clamp')).toBe('1')
    expect(declarationOf(rule, 'white-space')).not.toBe('nowrap')
  })

  // One chip, wherever a chip is: the badges on worktree rows, pane bars and
  // board rows used to pick their own radius — 3px, 99px and 999px between
  // them — and their own size, so the same kind of thing read three ways.
  it('draws every chip from one rule', () => {
    const chip = ruleFor('base.css', '.chip')
    expect(declarationOf(chip, 'border-radius')).toBe('var(--r1)')
    expect(declarationOf(chip, 'font-size')).toBe('var(--text-xs)')
    for (const [sheet, selector] of [
      ['sidebar.css', '.worktree__tag'],
      ['sidebar.css', '.worktree__merge'],
      ['panes.css', '.pane__exit'],
      ['panes.css', '.pane__restored--agent'],
      ['dashboard.css', '.board-row__kind']
    ] as const) {
      const rule = ruleFor(sheet, selector)
      expect(declarationOf(rule, 'border-radius'), selector).toBeUndefined()
      expect(declarationOf(rule, 'font-size'), selector).toBeUndefined()
    }
  })

  // The activity dot is one mark with one reading, on the sidebar, the strip,
  // the board and now the pane bar. A pane bar that drew its own 5px dot was
  // a second vocabulary for the same five states.
  it('has one activity dot, and no second dot on the pane bar', () => {
    expect(ruleFor('sidebar.css', '.activity')).toBeTruthy()
    expect(findRule('panes.css', '.pane__dot')).toBeUndefined()
  })

  // The strip is one row with one vertical centre. It used to sit the tabs on
  // its bottom edge and the split and + buttons in its middle, so the labels
  // centred eleven pixels lower than the icons beside them, and the active
  // tab's border stopped short of the strip's baseline. Every child now
  // centres on the same height, and the active mark is drawn on the strip's
  // own bottom edge rather than as a border on a shorter box.
  describe('the tab strip is one row', () => {
    it('centres the tabs, the pane buttons and the sidebar control on one height', () => {
      expect(declarationOf(ruleFor('workspace.css', '.tabs'), 'align-items')).toBe('center')
      expect(declarationOf(ruleFor('workspace.css', '.tabs__list'), 'align-self')).toBe('stretch')
      expect(declarationOf(ruleFor('workspace.css', '.tab'), 'align-items')).toBe('center')
      expect(declarationOf(ruleFor('workspace.css', '.tabs__actions'), 'align-self')).toBeUndefined()
    })

    it('marks the active tab on the strip’s bottom edge', () => {
      const active = ruleFor('workspace.css', '.tab--active')
      expect(declarationOf(active, 'box-shadow')).toMatch(/^inset 0 -2px 0 /)
      expect(declarationOf(ruleFor('workspace.css', '.tab'), 'border-bottom')).toBeUndefined()
    })

    it('draws the pane buttons’ icons in a 16px box', () => {
      const icon = ruleFor('workspace.css', '.tabs__action svg')
      expect(declarationOf(icon, 'width')).toBe('16px')
      expect(declarationOf(icon, 'height')).toBe('16px')
    })

    // Both strips are the window's top row, and on macOS the window buttons
    // are centred in whichever is at the left edge. Two heights would be a step
    // in the frame.
    it('is as tall as the sidebar’s header, so the two read as one bar', () => {
      expect(declarationOf(ruleFor('workspace.css', '.tabs'), 'height')).toBe(
        declarationOf(ruleFor('shell.css', '.sidebar__brand'), 'height')
      )
    })
  })

  // One frame for every dialog. The title is inset by the frame's own padding
  // and the body used to bring its own — or not: the two confirms brought none,
  // so their sentence started further left than the question above it. The
  // frame pads the body now, on the same edge as the head, and no content
  // class pads itself.
  describe('one dialog frame', () => {
    it('puts the body on the title’s edge', () => {
      const head = declarationOf(ruleFor('dialog.css', '.modal__head'), 'padding')
      const body = declarationOf(ruleFor('dialog.css', '.modal__body'), 'padding')
      expect(head?.split(' ')[1]).toBe('var(--s5)')
      expect(body).toBe('0 var(--s5) var(--s5)')
    })

    it('lets no dialog content pad or size itself', () => {
      for (const [sheet, selector] of [
        ['dialog.css', '.confirm'],
        ['dialog.css', '.consent'],
        ['dialog.css', '.form'],
        ['dialog.css', '.palette'],
        ['cli.css', '.cli-install'],
        ['appearance.css', '.appearance']
      ] as const) {
        const rule = ruleFor(sheet, selector)
        expect(declarationOf(rule, 'padding'), selector).toBeUndefined()
        expect(declarationOf(rule, 'width'), selector).toBeUndefined()
      }
    })

    it('centres the layer over the window', () => {
      const layer = ruleFor('dialog.css', '.modal-layer')
      expect(declarationOf(layer, 'place-items')).toBe('center')
      expect(declarationOf(layer, 'padding-top')).toBeUndefined()
    })

    it('ends every dialog in one right-aligned row with an 8px gap', () => {
      const actions = ruleFor('dialog.css', '.modal__actions')
      expect(declarationOf(actions, 'justify-content')).toBe('flex-end')
      expect(declarationOf(actions, 'gap')).toBe('8px')
      expect(findRule('dialog.css', '.confirm__actions')).toBeUndefined()
      expect(findRule('dialog.css', '.form__actions')).toBeUndefined()
      expect(findRule('dialog.css', '.consent__actions')).toBeUndefined()
    })
  })

  /**
   * Custom properties the shell writes onto the element itself, which no
   * stylesheet declares and none should: two of them come from
   * `src/shared/windowChrome.ts` — the main process reads the same numbers to
   * place the macOS window buttons — and one is a width somebody drags.
   */
  const SET_BY_THE_SHELL = new Set(['--sidebar-width', '--titlebar-h', '--titlebar-inset'])

  // A `var()` naming a property nothing declares is the quietest failure CSS
  // has. The declaration is thrown away at computed-value time, so the property
  // falls back to its inherited value and the rule simply does nothing: text
  // meant to brighten stays dim, a border meant to be drawn is not there, and
  // every gate in this repo is green. It is also exactly the shape a merge
  // leaves behind — a stylesheet written against a token another branch renamed
  // or never added — which is why it is checked across the whole set at once
  // rather than per file.
  it('names no custom property that nothing declares', () => {
    const declared = new Set<string>()
    for (const name of sheets) {
      postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkDecls(/^--/, (decl) => {
        declared.add(decl.prop)
      })
    }

    const dangling: string[] = []
    for (const name of sheets) {
      postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkDecls((decl) => {
        for (const [, property] of decl.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (property === undefined) continue
          if (declared.has(property) || SET_BY_THE_SHELL.has(property)) continue
          dangling.push(`${name}: ${decl.prop}: ${property}`)
        }
      })
    }
    expect(dangling).toEqual([])
  })

  // The palette is written twice on purpose — once as literals here, so the
  // first frame is painted before any script runs, and once as a derivation in
  // src/shared/theme.ts, which is what a theme switch and the colour editor
  // actually produce. Two copies of one thing drift, so this is the seam that
  // is not allowed to: a colour changed in one file and not the other would
  // otherwise show up as a window that changes shade a tick after it opens.
  describe('tokens.css against the default theme', () => {
    const declared = customProperties('tokens.css')
    const resolved = resolvePalette(DEFAULT_APPEARANCE)

    it.each(THEME_TOKENS)('--%s is the value the default theme resolves to', (token) => {
      expect(declared.get(`--${token}`)).toBe(resolved[token])
    })

    // The other direction: a token the theme layer knows about and the
    // stylesheet does not is a colour nothing can be styled in, and one the
    // stylesheet declares and the theme layer does not is a colour a theme
    // switch would leave behind at its old value.
    it('declares every themeable token and no colour outside them', () => {
      const themeable = new Set(THEME_TOKENS.map((token) => `--${token}`))
      const colours = [...declared].filter(([, value]) => /^(#|rgb\()/.test(value)).map(([name]) => name)
      expect(colours.filter((name) => !themeable.has(name))).toEqual([])
      expect([...themeable].filter((name) => !declared.has(name))).toEqual([])
    })
  })
})

/** Every custom property `:root` declares in one stylesheet, in order. */
function customProperties(name: string): Map<string, string> {
  const found = new Map<string, string>()
  postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkRules(':root', (rule) => {
    rule.walkDecls(/^--/, (decl) => {
      found.set(decl.prop, decl.value.trim())
    })
  })
  return found
}

/** The `z-index` one selector is given, across every stylesheet. */
function zIndexOf(selector: string): number {
  const found: number[] = []
  for (const name of sheets) {
    postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkRules(selector, (rule) => {
      rule.walkDecls('z-index', (decl) => {
        found.push(Number(decl.value))
      })
    })
  }
  // A selector with no z-index, or with two, makes the comparison meaningless
  // rather than false, and a comparison against nothing would pass quietly.
  expect(found, `${selector} should declare exactly one z-index`).toHaveLength(1)
  return found[0] ?? Number.NaN
}

/** The one rule with exactly this selector in the named sheet, or nothing. */
function findRule(sheet: string, selector: string): postcss.Rule | undefined {
  let found: postcss.Rule | undefined
  postcss.parse(readFileSync(path.join(here, sheet), 'utf8'), { from: sheet }).walkRules((rule) => {
    if (rule.selector === selector) found = rule
  })
  return found
}

/** Like `findRule`, but a missing rule is a failed test rather than a silent pass. */
function ruleFor(sheet: string, selector: string): postcss.Rule {
  const rule = findRule(sheet, selector)
  expect(rule, `${sheet} should have a rule for ${selector}`).toBeTruthy()
  return rule as postcss.Rule
}

function declarationOf(rule: postcss.Rule, prop: string): string | undefined {
  let value: string | undefined
  rule.walkDecls(prop, (decl) => {
    value = decl.value
  })
  return value
}
