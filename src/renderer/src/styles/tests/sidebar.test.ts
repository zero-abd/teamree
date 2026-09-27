// The sidebar's pins: the worktree box, its rows, and what a row shows at rest.

import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { declarationOf, findRule, parse, ruleFor, ruleListing } from './css'

const SHEET = 'sidebar.css'

describe('sidebar.css', () => {
  // `text-overflow: ellipsis` cuts mid-word; a one-line clamp ends on a word.
  it('ends a quoted line under a pane row on a word, not in the middle of one', () => {
    const rule = ruleFor(SHEET, '.pane-row__evidence')
    expect(declarationOf(rule, '-webkit-line-clamp')).toBe('1')
    expect(declarationOf(rule, 'white-space')).not.toBe('nowrap')
  })

  it('sets worktree names at the body size', () => {
    expect(declarationOf(ruleFor(SHEET, '.worktree__name'), 'font-size')).toBe('var(--text-base)')
  })

  it('labels the project list in sentence case', () => {
    const title = ruleFor(SHEET, '.sidebar__head-title')
    expect(declarationOf(title, 'text-transform')).toBeUndefined()
    expect(declarationOf(title, 'font-size')).toBe('var(--text-sm)')
  })

  // One activity dot, on sidebar, strip, board and pane bar.
  it('has one activity dot, and no second dot on the pane bar', () => {
    expect(ruleFor(SHEET, '.activity')).toBeTruthy()
    expect(findRule('panes.css', '.pane__dot')).toBeUndefined()
  })

  it('paints the sidebar on the rail', () => {
    expect(declarationOf(ruleFor(SHEET, '.sidebar'), 'background')).toBe('var(--bg-rail)')
  })

  it.each(['.worktree--active', '.rail__link--current'])(
    'fills the selected row %s with the selected surface',
    (selector) => {
      expect(declarationOf(ruleFor(SHEET, selector), 'background')).toBe('var(--bg-selected)')
    }
  )

  // A border on the current entry reads as a focus ring; the ring is keyboard focus's alone.
  it('fills the current rail entry the way the current worktree is filled', () => {
    const current = ruleFor(SHEET, '.rail__link--current')
    expect(declarationOf(current, 'border-color')).toBeUndefined()
    expect(declarationOf(current, 'background')).toBe(declarationOf(ruleFor(SHEET, '.worktree--active'), 'background'))
  })

  // The title line filled and a bar outside it made two frames, and half the box looked selected.
  it('marks the open worktree with one fill and one line around its whole box', () => {
    const active = ruleFor(SHEET, '.worktree--active')
    expect(declarationOf(active, 'border-color')).toBe('var(--accent-line)')
    expect(findRule(SHEET, '.worktree--active::before')).toBeUndefined()
    expect(findRule(SHEET, '.worktree--active .worktree__row')).toBeUndefined()
  })

  // A weight made names jump in width and the list look randomly bold.
  it('marks an unread worktree by ink and a dot after its name, never by weight', () => {
    const unread = ruleListing(SHEET, '.worktree__name--unread') as postcss.Rule
    expect(declarationOf(unread, 'font-weight')).toBeUndefined()
    expect(declarationOf(unread, 'color')).toBe('var(--fg)')
    expect(declarationOf(ruleFor(SHEET, '.worktree__name'), 'color')).toBe('var(--fg-secondary)')
    expect(declarationOf(ruleFor(SHEET, '.worktree__name--unread::after'), 'background')).toBe('var(--accent-bright)')
  })

  // A page holds the main area, so its rail entry is the one selected thing in the sidebar.
  it('leaves the open worktree its line, no fill, while a page is open', () => {
    const page = ruleFor(SHEET, '.sidebar--page .worktree--active')
    expect(declarationOf(page, 'background')).toBe('none')
    expect(declarationOf(page, 'border-color')).toBeUndefined()
  })

  // A quoted line in the terminal face read as log noise beside the names.
  it('sets a row’s secondary lines in the UI face and keeps mono for refs', () => {
    for (const selector of ['.pane-row__evidence', '.worktree__report', '.pane-row__label']) {
      const rule = ruleListing(SHEET, selector) as postcss.Rule
      expect(declarationOf(rule, 'font-family'), selector).toBeUndefined()
      expect(declarationOf(rule, 'font-size'), selector).toBe('var(--text-sm)')
    }
    expect(declarationOf(ruleListing(SHEET, '.worktree__report') as postcss.Rule, 'color')).toBe('var(--fg-secondary)')
    expect(declarationOf(ruleFor(SHEET, '.worktree__branch'), 'font-family')).toBe('var(--font-mono)')
  })

  // One card per worktree, its panes inside: a line and a corner from the tokens, a gap between cards.
  it('draws each worktree as a box of its own', () => {
    const box = ruleFor(SHEET, '.worktree')
    expect(declarationOf(box, 'border')).toBe('1px solid var(--line)')
    expect(declarationOf(box, 'border-radius')).toBe('var(--r2)')
    expect(declarationOf(box, 'padding')).toMatch(/^var\(--s\d\)$/)
    expect(declarationOf(ruleFor(SHEET, '.project__worktrees'), 'gap')).toMatch(/^var\(--s\d\)$/)
  })

  // Drawn outside, the ring of a 23px row covers the rows above and below it.
  it('draws the focus ring of a sidebar row inside the row', () => {
    for (const selector of [
      '.pane-row:focus-visible',
      '.worktree__open:focus-visible',
      '.project__toggle:focus-visible'
    ]) {
      const rule = ruleListing(SHEET, selector)
      expect(rule && declarationOf(rule, 'outline-offset'), selector).toBe('-2px')
    }
  })

  it('draws working as the one violet dot, and asking as the one that moves', () => {
    const violet: string[] = []
    parse(SHEET).walkRules(/\.activity/, (rule) => {
      rule.walkDecls('background', (decl) => {
        if (/--accent/.test(decl.value)) violet.push(rule.selector)
      })
    })
    expect(violet).toEqual(['.activity--working'])
    const moving: string[] = []
    parse(SHEET).walkDecls('animation', (decl) => {
      const rule = decl.parent as postcss.Rule
      if (rule.parent?.type === 'root' && /\.activity/.test(rule.selector)) moving.push(rule.selector)
    })
    expect(moving).toEqual(['.activity--waiting'])
  })

  // Amber is the asking agent's, so an overlap is blue and a conflict red.
  it('draws an overlap in the info tone and a conflicting one in the danger tone', () => {
    expect(declarationOf(ruleFor(SHEET, '.overlap--overlap'), 'color')).toBe('var(--info)')
    expect(declarationOf(ruleFor(SHEET, '.overlap--conflict'), 'color')).toBe('var(--danger)')
  })

  it('draws a pull request’s checks red, green or ink, never amber, straight on the ground', () => {
    expect(declarationOf(ruleFor(SHEET, '.prchip'), 'background')).toBe('transparent')
    expect(declarationOf(ruleFor(SHEET, '.prchip--fail'), 'color')).toBe('var(--danger)')
    expect(declarationOf(ruleFor(SHEET, '.prchip--pass'), 'color')).toBe('var(--success)')
    expect(declarationOf(ruleFor(SHEET, '.prchip--pending'), 'color')).toBe('var(--fg-secondary)')
  })

  it('draws the Settings mark, the change count and both merge marks in ink', () => {
    expect(declarationOf(ruleFor(SHEET, '.rail__badge'), 'background')).toBeUndefined()
    expect(declarationOf(ruleFor(SHEET, '.rail__badge'), 'color')).toMatch(/^var\(--fg/)
    expect(declarationOf(ruleFor(SHEET, '.worktree__merge--clean'), 'color')).toMatch(/^var\(--fg/)
    expect(declarationOf(ruleFor(SHEET, '.worktree__merge--conflicts'), 'color')).toMatch(/^var\(--fg/)
    expect(declarationOf(ruleFor(SHEET, '.worktree__merge--conflicts'), 'background')).toBeUndefined()
    expect(declarationOf(ruleFor(SHEET, '.gitchip--dirty'), 'color')).toBe('var(--fg-secondary)')
  })

  // The ⋯ is always drawn, so its room is always kept: nothing on the row moves when it is hovered.
  it('keeps the ⋯ its own room on the title line, and moves nothing on hover', () => {
    const action = ruleFor(SHEET, '.worktree__action')
    expect(declarationOf(action, 'position')).toBeUndefined()
    expect(declarationOf(action, 'flex')).toBe('none')
    expect(declarationOf(ruleFor(SHEET, '.worktree__open'), 'overflow')).toBe('hidden')
    const reflowing: string[] = []
    parse(SHEET).walkRules((rule) => {
      if (!/:hover|focus/.test(rule.selector) || !/\.worktree__(row|open|title|name|end)$/.test(rule.selector)) return
      rule.walkDecls(/^(padding|margin|width|gap|display)/, (decl) => {
        reflowing.push(`${rule.selector} { ${decl.prop} }`)
      })
    })
    expect(reflowing).toEqual([])
  })

  // Compact at 208px left a parent named `C` (#399): chips fold before the name gives way.
  it('keeps a row’s name readable beside its chips', () => {
    const name = ruleFor(SHEET, '.worktree__name')
    expect(declarationOf(name, 'min-width')).toBe('min(10ch, 70%)')
    expect(declarationOf(name, 'flex')).toBe('0 1000 auto')
    expect(declarationOf(ruleFor(SHEET, '.worktree__facts'), 'overflow')).toBe('hidden')
  })

  // A long project name drew the New Task button over "from m…" (#488); the smoke measures it at 208 and 272px.
  it('cuts a project’s name and base before its actions, and the base before the name', () => {
    const text = ruleFor(SHEET, '.project__text')
    expect(declarationOf(text, 'flex')).toBe('1 1 0')
    expect(declarationOf(text, 'min-width')).toBe('min(10ch, 100%)')
    expect(declarationOf(text, 'overflow')).toBe('clip')
    // The base wraps onto the clipped line below its floor rather than squeeze the name.
    expect(declarationOf(text, 'flex-wrap')).toBe('wrap')
    // Its own floor: a nowrap base's intrinsic width is the whole ref, which would wrap it every time.
    expect(declarationOf(ruleFor(SHEET, '.project__meta'), 'min-width')).toBe('8ch')
    expect(declarationOf(ruleFor(SHEET, '.project__base'), 'text-overflow')).toBe('ellipsis')
    // The actions never shrink; past the name's floor they take a line of their own.
    expect(declarationOf(ruleFor(SHEET, '.project__head'), 'flex-wrap')).toBe('wrap')
    expect(declarationOf(ruleFor(SHEET, '.project__actions'), 'flex')).toBe('none')
    expect(declarationOf(ruleFor(SHEET, '.project__actions > .button--icon'), 'flex')).toBe('none')
  })

  // On a narrow nested row the counts and the tally ran past the row's edge (#293).
  it('wraps a row’s facts under its branch rather than past the row’s edge', () => {
    expect(declarationOf(ruleFor(SHEET, '.worktree__meta'), 'flex-wrap')).toBe('wrap')
    // A zero basis: a long branch never pushes the facts onto a line of their own.
    expect(declarationOf(ruleFor(SHEET, '.worktree__branch'), 'flex')).toBe('1 1 0')
    // A floor, or chips squeezed it to `readm…`.
    expect(declarationOf(ruleFor(SHEET, '.worktree__branch'), 'min-width')).toBe('min(16ch, 100%)')
    expect(declarationOf(ruleFor(SHEET, '.worktree__tally'), 'margin-left')).toBe('auto')
  })

  // With the branch left out, `long notes index` folded both its chips into `+2`.
  it('wraps a title line’s chips under the name, except on a compact row', () => {
    expect(declarationOf(ruleFor(SHEET, '.worktree__title'), 'flex-wrap')).toBe('wrap')
    expect(declarationOf(ruleFor(SHEET, '.sidebar--compact .worktree__title'), 'flex-wrap')).toBe('nowrap')
  })

  // Twelve identical marks down the list said nothing; the open row keeps its own. Right-click
  // and the menu key reach every row's menu.
  it.each([
    ['.worktree__action', '.worktree--active > .worktree__row > .worktree__action'],
    ['.project__more', null]
  ])('keeps %s out of sight at rest, but for the open row', (selector, active) => {
    expect(declarationOf(ruleFor(SHEET, selector), 'opacity')).toBe('var(--row-action-rest)')
    if (active !== null) expect(declarationOf(ruleFor(SHEET, active), 'opacity')).toBe('var(--control-rest)')
  })

  // Answering is the most urgent thing on the row; under the pointer only, it also covered the question.
  it('draws a row’s answers at rest, in flow, never over the question', () => {
    const hiding: string[] = []
    parse(SHEET).walkRules((rule) => {
      if (!rule.selectors.some((each) => each.includes('.pane-item__answers'))) return
      rule.walkDecls((decl) => {
        if (/^(visibility|opacity|display|position)$/.test(decl.prop) && /hidden|^0$|none|absolute/.test(decl.value))
          hiding.push(`${rule.selector} { ${decl.prop}: ${decl.value} }`)
      })
    })
    expect(hiding).toEqual([])
  })

  it('mutes a row shown only for context by its ink, never by fading it', () => {
    const faded: string[] = []
    parse(SHEET).walkRules((rule) => {
      if (!rule.selector.includes('.worktree--context')) return
      rule.walkDecls('opacity', (decl) => {
        faded.push(`${rule.selector} { opacity: ${decl.value} }`)
      })
    })
    expect(faded).toEqual([])
    expect(declarationOf(ruleFor(SHEET, '.worktree--context .worktree__name'), 'color')).toBe('var(--fg-muted)')
  })

  it('rings the sidebar filter field as its chips are ringed', () => {
    expect(declarationOf(ruleFor(SHEET, '.sidebar__filter-field:focus-visible'), 'box-shadow')).toBe('var(--ring)')
  })

  // The row you are on showed less than the others: its ↑ and Δ only on hover.
  it('keeps the open worktree’s git chips on its row', () => {
    const hiding: string[] = []
    parse(SHEET).walkRules((rule) => {
      if (rule.selector.includes('.worktree--active') && rule.selector.includes('.worktree__git'))
        hiding.push(rule.selector)
    })
    expect(hiding).toEqual([])
  })
})
