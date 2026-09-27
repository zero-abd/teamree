/** @vitest-environment jsdom */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Icon, ICON_NAMES } from './Icon'

afterEach(cleanup)

describe('the icon set', () => {
  it.each(ICON_NAMES)('draws %s on the 16-unit grid in the text colour', (name) => {
    const { container } = render(<Icon name={name} />)
    const svg = container.querySelector('svg') as SVGSVGElement
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.childElementCount).toBeGreaterThan(0)
  })

  it('is named for screen readers when given a label', () => {
    const { container } = render(<Icon name="agent" label="Kiro" data-agent="kiro" />)
    const svg = container.querySelector('svg') as SVGSVGElement
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Kiro')
    expect(svg.hasAttribute('aria-hidden')).toBe(false)
    expect(svg.getAttribute('data-agent')).toBe('kiro')
  })

  it('draws at the size asked', () => {
    const { container } = render(<Icon name="close" size={14} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('14')
  })
})
