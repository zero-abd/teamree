// Icons come from the one set; a hand-drawn `<svg>` elsewhere is how five grids and seven strokes crept in.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// The set itself, the brand mark (the sidebar's and the empty state's), other products' marks and a data chart.
const ALLOWED = [
  'src/icons/Icon.tsx',
  'src/shell/Brand.tsx',
  'src/ui/EmptyState.tsx',
  'src/agents/glyphs.tsx',
  'src/shell/ResourcesControl.tsx'
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.(tsx|ts|jsx|js|html)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : []
  })
}

const files = sources(renderer).map((file) => path.relative(renderer, file).split(path.sep).join('/'))

describe('inline SVG in the renderer', () => {
  it('finds the sources to check', () => {
    expect(files).toContain('src/icons/Icon.tsx')
    expect(files.length).toBeGreaterThan(50)
  })

  it('draws icons only through the icon set', () => {
    const drawn = files.filter(
      (file) =>
        !ALLOWED.includes(file) &&
        /<svg\b[\s\S]*?<(path|circle|rect|line|polyline|polygon)\b/.test(
          readFileSync(path.join(renderer, file), 'utf8')
        )
    )
    expect(drawn).toEqual([])
  })
})
