// Rules for every stylesheet at once: they parse, take sizes, faces and colours from the tokens, and the
// tokens match the default presets. Each sheet's own pins live in `tests/<sheet>.test.ts`.

import { describe, expect, it } from 'vitest'
import { contrastRatio, mix, parseColor, type Rgb } from '@shared/color'
import {
  BUILT_IN_THEMES,
  DEFAULT_APPEARANCE,
  resolvePalette,
  THEME_TOKENS,
  themeTone,
  type Appearance
} from '@shared/theme'
import postcss from 'postcss'
import {
  customProperties,
  declarationOf,
  LIGHT_SCHEME,
  paletteOf,
  parse,
  rgbOf,
  ruleFor,
  ruleListing,
  sheets
} from './tests/css'

describe('stylesheets', () => {
  // If this ever finds nothing, the check has silently stopped checking.
  it('finds the stylesheets to check', () => {
    expect(sheets.length).toBeGreaterThan(5)
  })

  // CSS has no compiler in front of it: a rule that lost its body in a merge once passed every gate until the build.
  it.each(sheets)('%s parses', (name) => {
    expect(() => parse(name)).not.toThrow()
  })

  it.each(sheets)('%s has no rule with an empty body', (name) => {
    const empty: string[] = []
    parse(name).walkRules((rule) => {
      if (rule.nodes.length === 0) empty.push(rule.selector)
    })
    expect(empty).toEqual([])
  })

  // Icons take their size and stroke from `Icon`; per-stylesheet overrides are how five grids and seven strokes crept in.
  it('leaves every icon’s size and stroke to the icon set', () => {
    const overrides: string[] = []
    for (const name of sheets) {
      parse(name).walkDecls(/^(width|height|stroke-width)$/, (decl) => {
        const selector = (decl.parent as postcss.Rule).selector
        if (/\bsvg\b|\[data-icon\]/.test(selector) && !selector.includes('resources__spark'))
          overrides.push(`${name} ${selector} ${decl.prop}`)
      })
    }
    expect(overrides).toEqual([])
  })

  describe('one type scale', () => {
    it('reads no smaller than 11px: meta 11, labels 12, body 13, heading 15, title 19, page 26, code 13', () => {
      const tokens = customProperties('tokens.css')
      expect(tokens.get('--text-xs')).toBe('11px')
      expect(tokens.get('--text-sm')).toBe('12px')
      expect(tokens.get('--text-base')).toBe('13px')
      expect(tokens.get('--text-lg')).toBe('15px')
      expect(tokens.get('--text-xl')).toBe('19px')
      expect(tokens.get('--text-2xl')).toBe('26px')
      expect(tokens.get('--text-code')).toBe('13px')
    })

    // Only markdown headings and inline code size themselves, relative to the page.
    it('takes every font size from a token', () => {
      const literal: string[] = []
      for (const name of sheets) {
        parse(name).walkDecls('font-size', (decl) => {
          if (!/^(var\(--text-(xs|sm|base|lg|xl|2xl|code)\)|inherit|[\d.]+em)$/.test(decl.value))
            literal.push(`${name} ${(decl.parent as postcss.Rule).selector}`)
        })
      }
      expect(literal).toEqual([])
    })

    it('sets text in the UI face or the mono face only', () => {
      const other: string[] = []
      for (const name of sheets) {
        parse(name).walkDecls('font-family', (decl) => {
          const selector = (decl.parent as postcss.Rule).selector
          if (selector === '.md-bar__mark--italic') return
          if (!/^(var\(--font-(ui|mono)\)|inherit)$/.test(decl.value)) other.push(`${name} ${selector}`)
        })
      }
      expect(other).toEqual([])
    })

    // Chromium draws a bare button, field or select in Arial at 13.33px.
    it('lets every form control inherit the app’s font', () => {
      const reset = ruleListing('base.css', 'button')
      expect(reset?.selectors).toEqual(expect.arrayContaining(['button', 'input', 'select', 'textarea']))
      expect(declarationOf(reset as postcss.Rule, 'font')).toBe('inherit')
      expect(declarationOf(reset as postcss.Rule, 'letter-spacing')).toBe('inherit')
    })

    it('keeps the ramp’s tokens to the 4px grid and the named radii', () => {
      const tokens = customProperties('tokens.css')
      expect(['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map((s) => tokens.get(s))).toEqual([
        '4px',
        '8px',
        '12px',
        '16px',
        '24px',
        '32px',
        '40px',
        '48px'
      ])
      expect(['--r1', '--r2', '--r3', '--r4'].map((r) => tokens.get(r))).toEqual(['4px', '7px', '10px', '14px'])
      expect(['--control-sm', '--control-md', '--control-lg'].map((c) => tokens.get(c))).toEqual([
        '26px',
        '32px',
        '38px'
      ])
    })
  })

  // A group's strip is one token high; the head and the sidebar's header are the window's top row, one bar.
  it('sizes every group’s strip from one token, and the head as tall as the sidebar’s header', () => {
    expect(customProperties('tokens.css').get('--strip-h')).toBe('36px')
    expect(declarationOf(ruleFor('workspace.css', '.tabs'), 'height')).toBe('var(--strip-h)')
    expect(declarationOf(ruleFor('workspace.css', '.workspace__head'), 'height')).toBe(
      declarationOf(ruleFor('shell.css', '.sidebar__brand'), 'height')
    )
  })

  describe('motion', () => {
    it('moves at 70, 120, 180 and 280 ms, on the standard, enter, exit and spring curves', () => {
      const tokens = customProperties('tokens.css')
      expect(['--motion-instant', '--motion-fast', '--motion-base', '--motion-slow'].map((t) => tokens.get(t))).toEqual(
        ['70ms', '120ms', '180ms', '280ms']
      )
      expect(tokens.get('--ease')).toBe(tokens.get('--ease-standard'))
      for (const curve of ['--ease-enter', '--ease-exit', '--ease-spring']) {
        expect(tokens.get(curve), curve).toMatch(/^cubic-bezier\(/)
      }
    })

    // Final states only: no pulse, shimmer, slide or scale for anyone who asked for less motion.
    it('stills every animation and transition under reduced motion', () => {
      let rule: postcss.Rule | undefined
      parse('tokens.css').walkAtRules('media', (media) => {
        if (media.params !== '(prefers-reduced-motion: reduce)') return
        media.walkRules((each) => {
          rule = each
        })
      })
      expect(rule && declarationOf(rule, 'animation-duration')).toBe('0.001ms')
      expect(rule && declarationOf(rule, 'transition-duration')).toBe('0.001ms')
    })
  })

  // Amber means an agent is asking, so nothing else may be drawn in it.
  describe('colour means state', () => {
    it('uses the asking tone only for an agent that is asking', () => {
      const asking = new Set([
        '.activity--waiting',
        '.pane-row__since--waiting',
        '.statusbar__asking',
        '.board-filter__number--waiting',
        '.board-filter__number--asking',
        // A teammate's agent asking, as a card on the Teamwork page.
        '.home-card--asking',
        '.child__stage--asking',
        // A task's question for you, under its row.
        '.worktree__ask',
        // A teammate's agent asking: the head's cue and their group's row.
        '.project__cue--asking',
        '.teammate__doing--asking',
        // A worktree box an agent in it is asking from: its edge and its tint.
        '.worktree--asking',
        '.worktree--asking::before',
        // An asking worktree in a theme's miniature window.
        '.mini-window__tree--asking',
        // The status pill and the notice of an agent that is asking.
        '.status--asking',
        '.toast--asking::before'
      ])
      const elsewhere: string[] = []
      for (const name of sheets) {
        parse(name).walkDecls((decl) => {
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
        parse(name).walkRules((rule) => {
          if (/unread/.test(rule.selector) && /\.activity\b/.test(rule.selector))
            dotRules.push(`${name}: ${rule.selector}`)
        })
      }
      expect(dotRules).toEqual([])
    })
  })

  /** Properties the shell writes onto elements itself: two from `windowChrome.ts`, one a dragged width. */
  const SET_BY_THE_SHELL = new Set(['--sidebar-width', '--titlebar-h', '--titlebar-inset'])

  // The raw accent is a fill: as an ink it measures 2.6:1 on the Light preset's panel.
  it('prints accent-coloured text in accent-bright, never in the raw accent', () => {
    const raw: string[] = []
    for (const name of sheets) {
      parse(name).walkDecls('color', (decl) => {
        if (/var\(\s*--accent\s*\)/.test(decl.value)) raw.push(`${name}: ${(decl.parent as postcss.Rule).selector}`)
      })
    }
    expect(raw).toEqual([])
  })

  // A `var()` naming an undeclared property silently does nothing, and is what a merge leaves behind.
  it('names no custom property that nothing declares', () => {
    const declared = new Set<string>()
    for (const name of sheets) {
      parse(name).walkDecls(/^--/, (decl) => {
        declared.add(decl.prop)
      })
    }

    const dangling: string[] = []
    for (const name of sheets) {
      parse(name).walkDecls((decl) => {
        for (const [, property] of decl.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (property === undefined) continue
          if (declared.has(property) || SET_BY_THE_SHELL.has(property)) continue
          dangling.push(`${name}: ${decl.prop}: ${property}`)
        }
      })
    }
    expect(dangling).toEqual([])
  })

  // Colours come from the palette: a literal in a sheet is a colour no theme can reach.
  it('writes no colour literal outside the tokens', () => {
    const literal: string[] = []
    for (const name of sheets) {
      if (name === 'tokens.css') continue
      parse(name).walkDecls((decl) => {
        if (decl.prop.startsWith('--')) return
        const bare = decl.value.replace(/var\([^)]*\)/g, '')
        if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black)\b/i.test(bare))
          literal.push(`${name}: ${(decl.parent as postcss.Rule).selector} ${decl.prop}`)
      })
    }
    expect(literal).toEqual(DRAWN_ON_PURPOSE)
  })

  // The palette is literal here (first frame before scripts) and derived in src/shared/theme.ts; the two
  // must match or the window changes shade a tick after opening.
  describe('tokens.css against the default presets', () => {
    const declared = customProperties('tokens.css')
    const resolved = resolvePalette(DEFAULT_APPEARANCE)

    it.each(THEME_TOKENS)('--%s is the value the default theme resolves to', (token) => {
      expect(declared.get(`--${token}`)).toBe(resolved[token])
    })

    it.each(THEME_TOKENS)('--%s under a light system is the value the default light preset resolves to', (token) => {
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

  it.each(BUILT_IN_THEMES.map((theme) => theme.id))(
    'draws each git status at 3:1 or better on the panel in %s',
    (id) => {
      const palette = paletteOf(id)
      for (const tone of ['info', 'success', 'danger'] as const) {
        expect(contrastRatio(rgbOf(palette[tone]), rgbOf(palette['bg-panel'])), tone).toBeGreaterThanOrEqual(3)
      }
    }
  )

  it('shows a row’s own actions at rest where nothing can hover', () => {
    expect(customProperties('tokens.css').get('--row-action-rest')).toBe('0')
    expect(customProperties('tokens.css', '(hover: none)').get('--row-action-rest')).toBe('1')
  })

  it('draws resting controls at full strength where nothing can hover', () => {
    expect(customProperties('tokens.css').get('--control-rest')).toBe('0.8')
    expect(customProperties('tokens.css', '(hover: none)').get('--control-rest')).toBe('1')
  })

  // WCAG's 3:1 for a control's shape: the muted ink at the resting opacity, on each ground a resting control sits on.
  it.each(BUILT_IN_THEMES.map((theme) => theme.id))('keeps a resting icon control at 3:1 on %s', (id) => {
    const rest = Number(customProperties('tokens.css').get('--control-rest'))
    const appearance: Appearance =
      themeTone(id) === 'dark'
        ? { ...DEFAULT_APPEARANCE, mode: 'dark', themeId: id }
        : { ...DEFAULT_APPEARANCE, mode: 'light', light: { themeId: id, ground: null, accent: null, overrides: {} } }
    const palette = resolvePalette(appearance)
    const ink = parseColor(palette['fg-muted']) as Rgb
    for (const ground of ['bg-window', 'bg-rail', 'bg-panel'] as const) {
      const under = parseColor(palette[ground]) as Rgb
      const seen = mix(under, ink, rest)
      expect(contrastRatio(seen, under), `${ground} at ${rest}`).toBeGreaterThanOrEqual(3)
    }
  })
})

// Colours no theme should move: over a pasted image, the app icon's own tile, initials on a teammate's
// colour, and a mask's alpha.
const DRAWN_ON_PURPOSE = [
  'panes.css: .image-strip__n background',
  'panes.css: .image-strip__n color',
  'panes.css: .image-strip__remove background',
  'panes.css: .image-strip__remove box-shadow',
  'panes.css: .image-strip__remove color',
  'shell.css: .brand__tile border',
  'shell.css: .brand__tile background',
  'shell.css: .brand__mark color',
  'sidebar.css: .avatar color',
  'sidebar.css: .avatar--away color',
  'updates.css: .update-card__notes--clipped mask-image'
]
