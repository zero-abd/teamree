import { describe, expect, it } from 'vitest'
import { titleBarClassName } from './titleBarClass'

describe('titleBarClassName', () => {
  it('reserves room for the window buttons on macOS', () => {
    expect(titleBarClassName('darwin')).toBe('titlebar titlebar--mac')
  })

  it('reserves nothing where the OS draws its own title bar', () => {
    expect(titleBarClassName('win32')).toBe('titlebar')
    expect(titleBarClassName('linux')).toBe('titlebar')
  })

  it('falls back to the plain strip when the platform is unknown', () => {
    expect(titleBarClassName(undefined)).toBe('titlebar')
    expect(titleBarClassName('unknown')).toBe('titlebar')
  })

  it('recognises a browser user-agent, which is all a plain vite preview has', () => {
    expect(titleBarClassName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('titlebar titlebar--mac')
  })
})
