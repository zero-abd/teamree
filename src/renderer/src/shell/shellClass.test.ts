import { describe, expect, it } from 'vitest'
import { shellClassName } from './shellClass'

describe('shellClassName', () => {
  it('reserves room for the window buttons on macOS', () => {
    expect(shellClassName('darwin', true)).toBe('shell shell--mac')
  })

  // With the sidebar away, the strip beside it is what sits under the buttons,
  // so the shell has to say both things at once for the stylesheet to move the
  // inset across.
  it('says when the sidebar is away, so the strip can take the inset instead', () => {
    expect(shellClassName('darwin', false)).toBe('shell shell--mac shell--collapsed')
  })

  it('reserves nothing where the OS draws its own title bar', () => {
    expect(shellClassName('win32', true)).toBe('shell')
    expect(shellClassName('linux', false)).toBe('shell shell--collapsed')
  })

  it('falls back to the plain shell when the platform is unknown', () => {
    expect(shellClassName(undefined, true)).toBe('shell')
    expect(shellClassName('unknown', true)).toBe('shell')
  })

  it('recognises a browser user-agent, which is all a plain vite preview has', () => {
    expect(shellClassName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', true)).toBe('shell shell--mac')
  })
})
