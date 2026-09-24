// Every stylesheet has to parse: CSS has no compiler in front of it, and a rule that lost its body in a
// merge once passed every gate until the renderer build.

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

  // The shape that got through: a selector that declares nothing.
  it.each(sheets)('%s has no rule with an empty body', (name) => {
    const css = readFileSync(path.join(here, name), 'utf8')
    const empty: string[] = []
    postcss.parse(css, { from: name }).walkRules((rule) => {
      if (rule.nodes.length === 0) empty.push(rule.selector)
    })
    expect(empty).toEqual([])
  })

  // A notice under the modal scrim is painted and covered; the two z-indexes live in two files.
  it('stacks the notices above the modal layer, so no dialog can hide its own error', () => {
    expect(zIndexOf('.corner-stack')).toBeGreaterThan(zIndexOf('.modal-layer'))
  })

  // One stack in the bottom-right corner, so the update card and a notice never overlap.
  it('puts the update card in the notices’ stack rather than a corner of its own', () => {
    const stack = ruleFor('shell.css', '.corner-stack')
    expect(declarationOf(stack, 'position')).toBe('fixed')
    expect(declarationOf(stack, 'right')).toBeDefined()
    expect(declarationOf(stack, 'left')).toBeUndefined()
    expect(declarationOf(ruleFor('shell.css', '.notices'), 'position')).toBeUndefined()
    expect(declarationOf(ruleFor('updates.css', '.update-card'), 'position')).toBeUndefined()
  })

  // `text-overflow: ellipsis` cuts mid-word; a one-line clamp ends on a word.
  it('ends a quoted line under a pane row on a word, not in the middle of one', () => {
    const rule = ruleFor('sidebar.css', '.pane-row__evidence')
    expect(declarationOf(rule, '-webkit-line-clamp')).toBe('1')
    expect(declarationOf(rule, 'white-space')).not.toBe('nowrap')
  })

  // `break-all` split "(another copy)" as "(ano / ther copy)".
  it('wraps a path line in settings without splitting the words beside it', () => {
    const rule = ruleFor('settings.css', '.settings-fact--mono')
    expect(declarationOf(rule, 'word-break')).toBeUndefined()
    expect(declarationOf(rule, 'overflow-wrap')).toBe('anywhere')
  })

  // One chip radius and size everywhere.
  it('draws every chip from one rule', () => {
    const chip = ruleFor('base.css', '.chip')
    expect(declarationOf(chip, 'border-radius')).toBe('var(--r1)')
    expect(declarationOf(chip, 'font-size')).toBe('var(--text-xs)')
    for (const [sheet, selector] of [
      ['sidebar.css', '.worktree__tag'],
      ['sidebar.css', '.worktree__merge'],
      ['panes.css', '.pane__exit'],
      ['panes.css', '.pane__restored--agent']
    ] as const) {
      const rule = ruleFor(sheet, selector)
      expect(declarationOf(rule, 'border-radius'), selector).toBeUndefined()
      expect(declarationOf(rule, 'font-size'), selector).toBeUndefined()
    }
  })

  // One activity dot, on sidebar, strip, board and pane bar.
  it('has one activity dot, and no second dot on the pane bar', () => {
    expect(ruleFor('sidebar.css', '.activity')).toBeTruthy()
    expect(findRule('panes.css', '.pane__dot')).toBeUndefined()
  })

  // The strip has one vertical centre, and the active mark sits on its own bottom edge.
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

    // Both strips are the window's top row; two heights would be a step in the frame.
    it('is as tall as the sidebar’s header, so the two read as one bar', () => {
      expect(declarationOf(ruleFor('workspace.css', '.tabs'), 'height')).toBe(
        declarationOf(ruleFor('shell.css', '.sidebar__brand'), 'height')
      )
    })
  })

  // Settings, Help, Teamwork and All panes share one head and one column, so their edges line up.
  describe('one page frame', () => {
    it('measures the head and the body with one column', () => {
      const column = ruleFor('page.css', '.page__column')
      expect(declarationOf(column, 'max-width')).toBeDefined()
      expect(declarationOf(column, 'margin')).toBe('0 auto')
      const head = declarationOf(ruleFor('page.css', '.page__head'), 'padding')
      const body = declarationOf(ruleFor('page.css', '.page__body'), 'padding')
      expect(head?.split(' ')[1]).toBe(body?.split(' ')[1])
    })

    it('lets no page draw its own head, close or column', () => {
      for (const [sheet, selector] of [
        ['settings.css', '.settings__head'],
        ['settings.css', '.settings__close'],
        ['settings.css', '.settings__column'],
        ['help.css', '.help__head'],
        ['help.css', '.help__close'],
        ['dashboard.css', '.board__head'],
        ['dashboard.css', '.board__close'],
        ['members.css', '.teamwork-view__head'],
        ['members.css', '.teamwork-view__column']
      ] as const) {
        expect(findRule(sheet, selector), selector).toBeUndefined()
      }
    })

    // A border on the current entry reads as a focus ring; the ring is keyboard focus's alone.
    it('marks the current rail entry the way the current worktree is marked', () => {
      const current = ruleFor('sidebar.css', '.rail__link--current')
      expect(declarationOf(current, 'border-color')).toBeUndefined()
      expect(declarationOf(current, 'background')).toBe(
        declarationOf(ruleFor('sidebar.css', '.worktree--active .worktree__row'), 'background')
      )
      expect(declarationOf(ruleFor('sidebar.css', '.rail__link--current::before'), 'background')).toBe(
        declarationOf(ruleFor('sidebar.css', '.worktree--active::before'), 'background')
      )
    })
  })

  // A page holds the main area, so its rail entry is the one selected thing in the sidebar.
  it('leaves the open worktree a faint tick, no fill, while a page is open', () => {
    expect(declarationOf(ruleFor('sidebar.css', '.sidebar--page .worktree--active .worktree__row'), 'background')).toBe(
      'none'
    )
    const tick = ruleFor('sidebar.css', '.sidebar--page .worktree--active::before')
    expect(Number(declarationOf(tick, 'opacity'))).toBeLessThan(0.5)
  })

  // Drawn outside, the ring of a 23px row covers the rows above and below it.
  it('draws the focus ring of a sidebar row inside the row', () => {
    for (const selector of [
      '.pane-row:focus-visible',
      '.worktree__open:focus-visible',
      '.project__toggle:focus-visible'
    ]) {
      const rule = ruleListing('sidebar.css', selector)
      expect(rule && declarationOf(rule, 'outline-offset'), selector).toBe('-2px')
    }
  })

  // A menu writes its chords as the menu bar does: plain text at the right, no keycaps.
  // A 52px gutter left 266px of text in a 370px column.
  it('narrows the page gutter with its column', () => {
    const gutter = declarationOf(ruleFor('markdown.css', '.md-editor'), '--page-gutter') ?? ''
    const at = (width: number): number => {
      const parts = /^clamp\((\d+)px, ([\d.]+)cqi - ([\d.]+)px, (\d+)px\)$/.exec(gutter)
      expect(parts, `--page-gutter: ${gutter}`).not.toBeNull()
      const [low, per, less, high] = parts!.slice(1).map(Number) as [number, number, number, number]
      return Math.min(high, Math.max(low, (per * width) / 100 - less))
    }
    expect(at(370)).toBeLessThanOrEqual(16)
    expect(at(479)).toBeLessThanOrEqual(16)
    expect(at(760)).toBeCloseTo(52, 0)
    expect(at(600)).toBeLessThan(52)
  })

  // The editor's own `pre-wrap` split a one-line import in two.
  it('scrolls a code block sideways rather than wrapping it', () => {
    expect(declarationOf(ruleFor('markdown.css', '.md-editor .md-code pre'), 'white-space')).toBe('pre')
    expect(declarationOf(ruleFor('markdown.css', '.md-code pre'), 'overflow-x')).toBe('auto')
  })

  it('draws a menu chord as plain text', () => {
    const hint = ruleFor('sidebar.css', '.row-menu__hint')
    expect(declarationOf(hint, 'border')).toBe('0')
    expect(declarationOf(hint, 'background')).toBe('none')
    expect(declarationOf(hint, 'padding')).toBe('0')
  })

  // The frame pads the body on the same edge as the head; no content class pads itself.
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
        ['cli.css', '.cli-install']
      ] as const) {
        const rule = ruleFor(sheet, selector)
        expect(declarationOf(rule, 'padding'), selector).toBeUndefined()
        expect(declarationOf(rule, 'width'), selector).toBeUndefined()
      }
    })

    // A dialog whose height changes (a mode switch, a list filling) must not move under the pointer.
    it('anchors every dialog’s top edge, as the palette’s', () => {
      const layer = ruleFor('dialog.css', '.modal-layer')
      expect(declarationOf(layer, 'place-items')).toBe('start center')
      expect(declarationOf(layer, 'padding-block')?.split(' ')[0]).toBe('12vh')
      expect(findRule('dialog.css', '.modal-layer:has(.palette)')).toBeUndefined()
    })

    it('ends every dialog in one right-aligned row with an 8px gap', () => {
      const actions = ruleFor('dialog.css', '.modal__actions')
      expect(declarationOf(actions, 'justify-content')).toBe('flex-end')
      expect(declarationOf(actions, 'gap')).toBe('8px')
      expect(findRule('dialog.css', '.confirm__actions')).toBeUndefined()
      expect(findRule('dialog.css', '.form__actions')).toBeUndefined()
      expect(findRule('dialog.css', '.consent__actions')).toBeUndefined()
    })

    // A fieldset's legend is a label too; its default inset put "Agents" off the other labels' edge.
    it('sizes and insets every field label alike', () => {
      expect(declarationOf(ruleFor('dialog.css', '.field__label'), 'padding')).toBe('0')
      const overrides: string[] = []
      postcss.parse(readFileSync(path.join(here, 'dialog.css'), 'utf8')).walkRules((rule) => {
        if (rule.selector !== '.field__label' && rule.selector.includes('field__label')) overrides.push(rule.selector)
      })
      expect(overrides).toEqual([])
    })

    it('draws every picker at one height and size, the ref face changing only the family', () => {
      const picker = ruleFor('dialog.css', '.picker__input')
      expect(declarationOf(picker, 'height')).toBeDefined()
      expect(declarationOf(picker, 'font-size')).toBe('var(--text-base)')
      const ref = ruleFor('dialog.css', '.picker__input--ref')
      expect(declarationOf(ref, 'font-family')).toBe('var(--font-mono)')
      expect(declarationOf(ref, 'font-size')).toBeUndefined()
    })

    it('draws a stepper that cannot step like every other disabled button', () => {
      for (const property of ['border-color', 'background', 'color']) {
        expect(declarationOf(ruleFor('dialog.css', '.agents__step:disabled'), property)).toBe(
          declarationOf(ruleFor('base.css', '.button:disabled'), property)
        )
      }
    })

    // A dimmed accent reads as a pressable primary; disabled is one neutral look whatever the variant.
    it('greys a disabled button out rather than dimming its colour', () => {
      const disabled = ruleFor('base.css', '.button:disabled')
      expect(declarationOf(disabled, 'opacity')).toBeUndefined()
      expect(declarationOf(disabled, 'color')).toBe('var(--fg-muted)')
      expect(declarationOf(disabled, 'background')).toBe('transparent')
    })

    it('keeps the Changes header one height in every state', () => {
      const head = ruleFor('rightPanel.css', '.changes__head')
      expect(declarationOf(head, 'height')).toBe('38px')
      expect(declarationOf(head, 'flex-wrap')).toBeUndefined()
      expect(findRule('rightPanel.css', '.changes__pushError')).toBeDefined()
      expect(declarationOf(ruleFor('rightPanel.css', '.changes__pushError'), 'flex-basis')).toBeUndefined()
    })
  })

  // The chosen swatch's ring is 4px wide; with no room above it, it cut into the Accent label.
  it('leaves the accent swatches room for their selection ring', () => {
    expect(declarationOf(ruleFor('appearance.css', '.appearance__legend'), 'margin-bottom')).toBe('var(--s2)')
    expect(declarationOf(ruleFor('appearance.css', '.appearance__accents'), 'padding-block')).toBe('4px')
  })

  // Amber means an agent is asking, so nothing else may be drawn in it.
  describe('colour means state', () => {
    it('uses the asking tone only for an agent that is asking', () => {
      const asking = new Set([
        '.activity--waiting',
        '.pane-row__since--waiting',
        '.statusbar__asking',
        '.board-filter__number--waiting',
        '.board-row__state--waiting'
      ])
      const elsewhere: string[] = []
      for (const name of sheets) {
        postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkDecls((decl) => {
          if (!/var\(\s*--warning\s*\)/.test(decl.value)) return
          const selector = (decl.parent as postcss.Rule).selector
          if (!asking.has(selector)) elsewhere.push(`${name}: ${selector}`)
        })
      }
      expect(elsewhere).toEqual([])
    })

    // Unread is a name's weight: a dot recoloured or ringed for it read as working, or as a second asking.
    it('lets nothing but the state colour a dot', () => {
      const dotRules: string[] = []
      for (const name of sheets) {
        postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkRules((rule) => {
          if (/unread/.test(rule.selector) && /\.activity\b/.test(rule.selector))
            dotRules.push(`${name}: ${rule.selector}`)
        })
      }
      expect(dotRules).toEqual([])
    })

    it('draws working as the one violet dot, and asking as the one that moves', () => {
      const violet: string[] = []
      postcss.parse(readFileSync(path.join(here, 'sidebar.css'), 'utf8')).walkRules(/\.activity/, (rule) => {
        rule.walkDecls('background', (decl) => {
          if (/--accent/.test(decl.value)) violet.push(rule.selector)
        })
      })
      expect(violet).toEqual(['.activity--working'])
      const moving: string[] = []
      postcss.parse(readFileSync(path.join(here, 'sidebar.css'), 'utf8')).walkDecls('animation', (decl) => {
        const rule = decl.parent as postcss.Rule
        if (rule.parent?.type === 'root' && /\.activity/.test(rule.selector)) moving.push(rule.selector)
      })
      expect(moving).toEqual(['.activity--waiting'])
    })

    it('marks a folder holding changes in the file letter’s ink', () => {
      expect(declarationOf(ruleFor('rightPanel.css', '.tree__under'), 'background')).toBe(
        declarationOf(ruleFor('workspace.css', '.change__kind'), 'color')
      )
    })

    it('draws the Settings mark, the change count and the clean-merge mark in ink', () => {
      expect(declarationOf(ruleFor('sidebar.css', '.rail__badge'), 'background')).toBeUndefined()
      expect(declarationOf(ruleFor('sidebar.css', '.rail__badge'), 'color')).toMatch(/^var\(--fg/)
      expect(declarationOf(ruleFor('sidebar.css', '.worktree__merge--clean'), 'color')).toMatch(/^var\(--fg/)
      expect(declarationOf(ruleFor('sidebar.css', '.gitchip--dirty'), 'color')).toBe('var(--fg-secondary)')
    })

    it('hides the open worktree’s git facts until the row is hovered or focused', () => {
      const hidden = ruleFor('sidebar.css', '.worktree--active:not(:hover, :focus-within) .worktree__git')
      expect(declarationOf(hidden, 'display')).toBe('none')
    })

    // The hidden ⋯ held 24px of every row; it takes room only while it shows.
    it('keeps the row’s hidden ⋯ out of the title’s width', () => {
      expect(declarationOf(ruleFor('sidebar.css', '.worktree__action'), 'position')).toBe('absolute')
      const shown =
        ".worktree:is(:hover, :focus-within, :has(.worktree__action[aria-expanded='true'])) .worktree__row:has(> .worktree__action)"
      expect(declarationOf(ruleFor('sidebar.css', shown), 'padding-right')).toBeDefined()
    })

    // Closed, the panel is a 30px strip with a 1px border; a count on its edge was clipped.
    it('keeps a closed rail’s counts at least 2px inside the rail', () => {
      const px = (value: string | undefined): number => Number.parseFloat(value ?? 'NaN')
      const inner = px(declarationOf(ruleFor('rightPanel.css', '.panel--closed'), 'width')) - 1
      const tab = px(declarationOf(ruleFor('rightPanel.css', '.panel__rail--edge .panel__tab'), 'width'))
      const right = px(declarationOf(ruleFor('rightPanel.css', '.panel__rail--edge .panel__count'), 'right'))
      expect((inner - tab) / 2 + right).toBeGreaterThanOrEqual(2)
    })
  })

  // Sheets and side panels move in about a sixth of a second; ambient motion is the asking dot alone.
  describe('motion', () => {
    it('slides the Appearance sheet in from the right', () => {
      const animation = declarationOf(ruleFor('appearance.css', '.appearance-sheet'), 'animation') ?? ''
      expect(animation).toContain('var(--motion-base)')
      const from = keyframeFrom('appearance.css', animation.split(' ')[0] ?? '')
      expect(declarationOf(from, 'transform')).toBe('translateX(100%)')
    })

    // A width with the same number of tracks either side interpolates; `1fr` alone against three does not.
    it('animates the sidebar’s column and the right panel’s width', () => {
      expect(declarationOf(ruleFor('shell.css', '.shell'), 'transition')).toBe(
        'grid-template-columns var(--motion-base) var(--ease)'
      )
      const tracks = (selector: string): number =>
        (declarationOf(ruleFor('shell.css', selector), 'grid-template-columns') ?? '').split(/ (?![^(]*\))/).length
      expect(tracks('.shell--collapsed')).toBe(tracks('.shell'))
      expect(declarationOf(ruleFor('rightPanel.css', '.panel'), 'transition')).toBe(
        'width var(--motion-base) var(--ease)'
      )
    })

    it('follows a dragged edge without easing behind it', () => {
      const rule = ruleListing('base.css', 'body.is-resizing .shell')
      expect(rule?.selectors).toContain('body.is-resizing .panel')
      expect(rule && declarationOf(rule, 'transition')).toBe('none')
    })

    // A page is a `.workspace` too, so one fade covers opening a page and coming back from it.
    it('fades a page, the panes, and a zoom in or out, quickly', () => {
      for (const [sheet, selector] of [
        ['workspace.css', '.workspace'],
        ['workspace.css', '.workspace__panes'],
        ['workspace.css', '.workspace__panes--zoomed']
      ] as const) {
        expect(declarationOf(ruleFor(sheet, selector), 'animation'), selector).toMatch(/ var\(--motion-fast\) /)
      }
      // A zoom restarts the fade only if the name changes with it.
      const name = (selector: string): string | undefined =>
        declarationOf(ruleFor('workspace.css', selector), 'animation')?.split(' ')[0]
      expect(name('.workspace__panes--zoomed')).not.toBe(name('.workspace__panes'))
    })
  })

  /** Properties the shell writes onto elements itself: two from `windowChrome.ts`, one a dragged width. */
  const SET_BY_THE_SHELL = new Set(['--sidebar-width', '--titlebar-h', '--titlebar-inset'])

  // A `var()` naming an undeclared property silently does nothing, and is what a merge leaves behind,
  // so the whole set is checked at once.
  // The raw accent is a fill: as an ink it measures 2.6:1 on the Light preset's panel.
  it('prints accent-coloured text in accent-bright, never in the raw accent', () => {
    const raw: string[] = []
    for (const name of sheets) {
      postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkDecls('color', (decl) => {
        if (/var\(\s*--accent\s*\)/.test(decl.value)) raw.push(`${name}: ${(decl.parent as postcss.Rule).selector}`)
      })
    }
    expect(raw).toEqual([])
  })

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

  // The palette is literal here (first frame before scripts) and derived in src/shared/theme.ts; the two
  // must match or the window changes shade a tick after opening.
  describe('tokens.css against the default theme', () => {
    const declared = customProperties('tokens.css')
    const resolved = resolvePalette(DEFAULT_APPEARANCE)

    it.each(THEME_TOKENS)('--%s is the value the default theme resolves to', (token) => {
      expect(declared.get(`--${token}`)).toBe(resolved[token])
    })

    it.each(THEME_TOKENS)('--%s under a light system is the value the Light preset resolves to', (token) => {
      expect(customProperties('tokens.css', LIGHT_SCHEME).get(`--${token}`)).toBe(
        resolvePalette(DEFAULT_APPEARANCE, 'light')[token]
      )
    })

    // Both directions: a token either side lacks is unstyleable or left behind by a theme switch.
    it('declares every themeable token and no colour outside them', () => {
      const themeable = new Set(THEME_TOKENS.map((token) => `--${token}`))
      const colours = [...declared].filter(([, value]) => /^(#|rgb\()/.test(value)).map(([name]) => name)
      expect(colours.filter((name) => !themeable.has(name))).toEqual([])
      expect([...themeable].filter((name) => !declared.has(name))).toEqual([])
    })
  })
})

const LIGHT_SCHEME = '(prefers-color-scheme: light)'

/** Every custom property `:root` declares in one stylesheet, at the top level or inside one `@media`. */
function customProperties(name: string, media?: string): Map<string, string> {
  const found = new Map<string, string>()
  postcss.parse(readFileSync(path.join(here, name), 'utf8'), { from: name }).walkRules(':root', (rule) => {
    const parent = rule.parent
    const within = parent?.type === 'atrule' ? (parent as postcss.AtRule).params : undefined
    if (within !== media) return
    rule.walkDecls(/^--/, (decl) => {
      found.set(decl.prop, decl.value.trim())
    })
  })
  return found
}

/** The `from` step of a named `@keyframes` in one stylesheet. */
function keyframeFrom(sheet: string, name: string): postcss.Rule {
  let found: postcss.Rule | undefined
  postcss.parse(readFileSync(path.join(here, sheet), 'utf8'), { from: sheet }).walkAtRules('keyframes', (rule) => {
    if (rule.params !== name) return
    rule.walkRules('from', (step) => {
      found = step
    })
  })
  expect(found, `${sheet} should have @keyframes ${name} with a from step`).toBeTruthy()
  return found as postcss.Rule
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
  // No z-index, or two, would make the comparison pass quietly.
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

/** The rule whose selector list includes `selector`, alone or among others. */
function ruleListing(sheet: string, selector: string): postcss.Rule | undefined {
  let found: postcss.Rule | undefined
  postcss.parse(readFileSync(path.join(here, sheet), 'utf8'), { from: sheet }).walkRules((rule) => {
    if (rule.selectors.includes(selector)) found = rule
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
