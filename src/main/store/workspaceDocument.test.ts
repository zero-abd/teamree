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

  it('keeps the issue a worktree was started from, and drops a mangled one', () => {
    const linked = { ...worktree, issue: { number: 12, url: 'https://github.com/acme/pager/issues/12' } }
    expect(parseWorkspaceDocument({ worktrees: [linked] }).worktrees).toEqual([linked])
    const mangled = { ...worktree, issue: { number: 'twelve' } }
    expect(parseWorkspaceDocument({ worktrees: [mangled] }).worktrees).toEqual([worktree])
  })

  it('keeps the ref a worktree was started from beside its sha, and drops a mangled one', () => {
    const resolved = { ...worktree, startedFrom: 'a'.repeat(40), startedFromRef: 'origin/main' }
    expect(parseWorkspaceDocument({ worktrees: [resolved] }).worktrees).toEqual([resolved])
    const mangled = { ...resolved, startedFromRef: '' }
    expect(parseWorkspaceDocument({ worktrees: [mangled] }).worktrees).toEqual([
      { ...resolved, startedFromRef: undefined }
    ])
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
      showInMenuBar: true,
      warnAgentsAboutOverlaps: true
    })
    expect(parseWorkspaceDocument({ settings: 'on' }).settings).toEqual({})
  })
})

describe('workspace document: project fields', () => {
  const project = { id: 'proj_1', name: 'api', path: '/tmp/api', baseRef: 'origin/main' }

  it('keeps Fetch in Background off across a relaunch', () => {
    expect(parseWorkspaceDocument({ projects: [{ ...project, fetchInBackground: false }] }).projects).toEqual([
      { ...project, fetchInBackground: false }
    ])
    expect(parseWorkspaceDocument({ projects: [project] }).projects).toEqual([project])
  })
})

describe('workspace document: saved commands', () => {
  const project = { id: 'proj_1', name: 'api', path: '/tmp/api', baseRef: 'origin/main' }
  const lint = { id: 'c1', label: 'Lint', text: 'npm run lint', kind: 'shell', where: 'new' }
  const review = {
    id: 'c2',
    label: 'Review',
    text: 'Review the diff',
    kind: 'agent',
    where: 'current',
    agent: 'claude'
  }

  it('keeps a project’s commands and approvals, and the list for every project', () => {
    const stored = { ...project, savedCommands: [lint, review], approvedSavedCommands: ['make db'] }
    const document = parseWorkspaceDocument({ projects: [stored], settings: { savedCommands: [review] } })
    expect(document.projects).toEqual([stored])
    expect(document.settings).toEqual({ savedCommands: [review] })
  })

  it('drops a mangled command, never the project, the rest of the list or the other settings', () => {
    const blank = { ...lint, id: 'c3', label: '' }
    const robot = { ...lint, id: 'c4', kind: 'robot' }
    const document = parseWorkspaceDocument({
      projects: [
        { ...project, savedCommands: [lint, blank, robot] },
        { ...project, id: 'proj_2', savedCommands: 'lint', approvedSavedCommands: [3] }
      ],
      settings: { savedCommands: [5, lint], showCost: true }
    })
    expect(document.projects).toEqual([
      { ...project, savedCommands: [lint] },
      { ...project, id: 'proj_2' }
    ])
    expect(document.settings).toEqual({ savedCommands: [lint], showCost: true })
  })
})
