/** @vitest-environment jsdom */

// A teammate's face: initials on a colour that is theirs on every machine, and whether they are here.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Avatar, AVATAR_HUES, avatarHue, avatarInitials } from './Avatar'

afterEach(cleanup)

describe('avatarInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(avatarInitials('Mate Tester')).toBe('MT')
    expect(avatarInitials('ana-lopez')).toBe('AL')
    expect(avatarInitials('j.doe')).toBe('JD')
  })

  it('takes two letters of a single word, like a name', () => {
    expect(avatarInitials('bo')).toBe('Bo')
    expect(avatarInitials('priya')).toBe('Pr')
    expect(avatarInitials('x')).toBe('X')
  })

  it('never draws nothing', () => {
    expect(avatarInitials('  ')).toBe('?')
  })
})

describe('avatarHue', () => {
  it('is the same for the same handle, so a person is one colour on every machine', () => {
    expect(avatarHue('bo')).toBe(avatarHue('bo'))
    expect(AVATAR_HUES).toContain(avatarHue('ana'))
  })

  it('spreads a small team over different colours', () => {
    const hues = new Set(['ana', 'bo', 'priya', 'sam'].map(avatarHue))
    expect(hues.size).toBeGreaterThanOrEqual(3)
  })
})

describe('Avatar', () => {
  it('draws the initials on their colour, with the presence as a class and in words', () => {
    const { container } = render(<Avatar handle="bo" presence="online" />)
    const face = container.querySelector('.avatar') as HTMLElement
    expect(face.textContent).toBe('Bo')
    expect(face.classList.contains('avatar--online')).toBe(true)
    expect(face.style.getPropertyValue('--avatar-hue')).toBe(String(avatarHue('bo')))
    expect(face.getAttribute('aria-label')).toBe('bo, online')
  })

  it('draws no presence mark when presence is not known', () => {
    const { container } = render(<Avatar handle="bo" size="xs" />)
    const face = container.querySelector('.avatar') as HTMLElement
    expect(face.classList.contains('avatar--xs')).toBe(true)
    expect(face.getAttribute('aria-label')).toBe('bo')
    expect(container.querySelector('.avatar__presence')).toBeNull()
  })

  it('can be decorative where the handle is already said beside it', () => {
    const { container } = render(<Avatar handle="bo" presence="away" decorative />)
    const face = container.querySelector('.avatar') as HTMLElement
    expect(face.getAttribute('aria-hidden')).toBe('true')
    expect(face.getAttribute('aria-label')).toBeNull()
    expect(face.classList.contains('avatar--away')).toBe(true)
  })

  // Two letters at the smallest text size do not fit the smallest face.
  it('draws one letter on the smallest face', () => {
    const { container } = render(<Avatar handle="Mate Tester" size="xs" />)
    expect(container.querySelector('.avatar')?.textContent).toBe('M')
    expect(container.querySelector('.avatar')?.getAttribute('aria-label')).toBe('Mate Tester')
  })
})
