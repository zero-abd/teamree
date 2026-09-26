import { describe, expect, it } from 'vitest'
import { isPermissionMode, permissionArgs, permissionModesFor } from './permissionMode'

describe('the flags each permission mode launches with', () => {
  it('gives Claude Code its auto mode and its skip-everything flag', () => {
    expect(permissionArgs('claude', 'default')).toBe('')
    expect(permissionArgs('claude', 'auto')).toBe('--permission-mode auto')
    expect(permissionArgs('claude', 'bypass')).toBe('--dangerously-skip-permissions')
  })

  it('gives Codex a writable sandbox, or no sandbox and no approvals', () => {
    expect(permissionArgs('codex', 'default')).toBe('')
    expect(permissionArgs('codex', 'auto')).toBe('--sandbox workspace-write --ask-for-approval on-request')
    expect(permissionArgs('codex', 'bypass')).toBe('--dangerously-bypass-approvals-and-sandbox')
  })

  it('passes nothing to a harness whose flags are unknown', () => {
    for (const kind of ['gemini', 'unknown', 'toString', '__proto__']) {
      expect(permissionModesFor(kind)).toEqual([])
      expect(permissionArgs(kind, 'auto')).toBe('')
      expect(permissionArgs(kind, 'bypass')).toBe('')
    }
  })

  it('offers all three modes where it has flags', () => {
    expect(permissionModesFor('claude')).toEqual(['default', 'auto', 'bypass'])
    expect(permissionModesFor('codex')).toEqual(['default', 'auto', 'bypass'])
  })

  it('knows its own modes and nothing else', () => {
    expect(isPermissionMode('bypass')).toBe(true)
    expect(isPermissionMode('bypassPermissions')).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
  })
})
