import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/settings'
import { parseWorkspaceDocument, runtimeSettings } from './workspaceDocument'

const worktree = {
  id: 'wt_1',
  projectId: 'proj_1',
  name: 'rework auth',
  branch: 'rework-auth',
  path: '/tmp/rework-auth',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 1
}

describe('workspace document: task-tree fields and settings', () => {
  it('reads a file written before them', () => {
    const document = parseWorkspaceDocument({ version: 1, worktrees: [worktree] })
    expect(document.worktrees).toEqual([worktree])
    expect(document.settings).toEqual({})
    expect(runtimeSettings(document.settings)).toEqual(DEFAULT_RUNTIME_SETTINGS)
  })

  it('keeps a parent and a report', () => {
    const child = {
      ...worktree,
      id: 'wt_2',
      parentId: 'wt_1',
      report: { outcome: 'succeeded', summary: 'Added the migration.', paths: ['db/001.sql'], at: 5 }
    }
    expect(parseWorkspaceDocument({ worktrees: [worktree, child] }).worktrees).toEqual([worktree, child])
  })

  it('drops a mangled parent or report and keeps the worktree', () => {
    const mangled = { ...worktree, parentId: '', report: { outcome: 'maybe' } }
    expect(parseWorkspaceDocument({ worktrees: [mangled] }).worktrees).toEqual([worktree])
  })

  it('reads settings one switch at a time', () => {
    const document = parseWorkspaceDocument({
      settings: { shareTaskDetails: false, showCost: 'yes', jacMemoryAddon: true }
    })
    expect(document.settings).toEqual({ shareTaskDetails: false, jacMemoryAddon: true })
    expect(runtimeSettings(document.settings)).toEqual({
      shareTaskDetails: false,
      showCost: false,
      jacMemoryAddon: true,
      showInMenuBar: true
    })
    expect(parseWorkspaceDocument({ settings: 'on' }).settings).toEqual({})
  })
})
