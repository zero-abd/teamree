import { describe, expect, it } from 'vitest'
import type { MenuBarItem } from '../menuBar'
import { createCommandRelay } from './commandRelay'

const item = (command: string, enabled = true): MenuBarItem => ({
  command,
  label: command,
  accelerator: '',
  section: 'file',
  enabled
})

describe('createCommandRelay', () => {
  it('chooses at once in a window that has published the command', () => {
    const chosen: string[] = []
    const relay = createCommandRelay()
    relay.published([item('open-settings')], (command) => chosen.push(command))
    relay.run('open-settings')
    expect(chosen).toEqual(['open-settings'])
  })

  it('holds a command until a window publishes it enabled, then chooses it once', () => {
    const chosen: string[] = []
    const relay = createCommandRelay()
    relay.run('new-worktree')
    relay.published([], (command) => chosen.push(`gone ${command}`))
    relay.published([item('new-worktree', false)], (command) => chosen.push(`early ${command}`))
    relay.published([item('new-worktree')], (command) => chosen.push(command))
    relay.published([item('new-worktree')], (command) => chosen.push(`again ${command}`))
    expect(chosen).toEqual(['new-worktree'])
  })

  it('keeps only the latest command asked for', () => {
    const chosen: string[] = []
    const relay = createCommandRelay()
    relay.run('new-worktree')
    relay.run('open-settings')
    relay.published([item('new-worktree'), item('open-settings')], (command) => chosen.push(command))
    expect(chosen).toEqual(['open-settings'])
  })
})
