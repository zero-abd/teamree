import { describe, expect, it } from 'vitest'
import { MAX_HANDLE_LENGTH, resolveHandle, sanitiseHandle } from './handle'

describe('choosing a handle', () => {
  it('names a person after the email their commits already carry', () => {
    expect(resolveHandle({ gitEmail: 'ada.lovelace@example.com' })).toBe('ada.lovelace')
  })

  it('lets an explicit handle win over anything git has to say', () => {
    expect(resolveHandle({ override: 'ada', gitEmail: 'someone.else@example.com' })).toBe('ada')
  })

  it('asks rather than inventing a name when git has no email configured', () => {
    expect(resolveHandle({})).toBeUndefined()
    expect(resolveHandle({ gitEmail: '' })).toBeUndefined()
  })
})

describe('sanitising a handle into a file name', () => {
  it('keeps a name that is already safe exactly as it is', () => {
    expect(sanitiseHandle('ada.lovelace-1_x')).toBe('ada.lovelace-1_x')
  })

  it('folds case, because the roster is read on case-insensitive filesystems', () => {
    expect(sanitiseHandle('Ada.Lovelace')).toBe('ada.lovelace')
  })

  it('replaces anything a path would argue with', () => {
    expect(sanitiseHandle('ada/../lovelace')).toBe('ada-lovelace')
    expect(sanitiseHandle('a b\tc')).toBe('a-b-c')
    expect(sanitiseHandle('ada+lovelace@home')).toBe('ada-lovelace-home')
  })

  it('never leaves a separator at either end, however the name was cut short', () => {
    expect(sanitiseHandle('--ada--')).toBe('ada')
    expect(sanitiseHandle('...ada...')).toBe('ada')
    const long = `${'a'.repeat(MAX_HANDLE_LENGTH - 1)}-tail`
    expect(sanitiseHandle(long)).toBe('a'.repeat(MAX_HANDLE_LENGTH - 1))
  })

  it('refuses a name Windows would not let one member create', () => {
    expect(sanitiseHandle('nul')).toBeUndefined()
    expect(sanitiseHandle('COM1')).toBeUndefined()
  })

  it('refuses a name with nothing usable left in it rather than making one up', () => {
    expect(sanitiseHandle('///')).toBeUndefined()
    expect(sanitiseHandle('')).toBeUndefined()
    expect(sanitiseHandle(undefined)).toBeUndefined()
  })
})
