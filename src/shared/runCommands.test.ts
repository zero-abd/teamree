import { describe, expect, it } from 'vitest'
import type { Project, Terminal } from './entities'
import { effectiveProjectSettings, projectFileContents } from './projectSettings'
import { runCommandOf, runPaneOf, runState } from './runCommands'

const BASE: Project = { id: 'p', name: 'pantry', path: '/repos/pantry', baseRef: 'origin/main' }

function pane(id: string, extra: Partial<Terminal> = {}): Terminal {
  return {
    id,
    worktreeId: 'w1',
    title: 'zsh',
    cwd: '/w1',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...extra
  }
}

describe('which command a Run button starts', () => {
  it('takes this Mac’s, then the repository’s, then the detected one', () => {
    const detectedRun = { dev: 'npm run dev', test: 'npm test' }
    expect(runCommandOf({ ...BASE, detectedRun }, 'dev')).toEqual({
      command: 'npm run dev',
      source: 'detected',
      approved: true
    })
    const repository = { runCommands: { dev: 'make serve' } }
    expect(runCommandOf({ ...BASE, detectedRun, repository }, 'dev')?.source).toBe('repository')
    expect(runCommandOf({ ...BASE, detectedRun, repository }, 'test')?.command).toBe('npm test')
    expect(runCommandOf({ ...BASE, detectedRun, repository, runCommands: { dev: 'vite' } }, 'dev')).toEqual({
      command: 'vite',
      source: 'local',
      approved: true
    })
    expect(runCommandOf(BASE, 'test')).toBeUndefined()
  })

  it('asks about a repository command until this exact string is approved', () => {
    const repository = { runCommands: { test: 'make test' } }
    expect(runCommandOf({ ...BASE, repository }, 'test')?.approved).toBe(false)
    expect(runCommandOf({ ...BASE, repository, approvedRunCommands: { test: 'make test' } }, 'test')?.approved).toBe(
      true
    )
    expect(
      runCommandOf({ ...BASE, repository, approvedRunCommands: { test: 'make test-all' } }, 'test')?.approved
    ).toBe(false)
  })

  it('saves this Mac’s commands over the repository’s, kind by kind', () => {
    const project = { ...BASE, repository: { runCommands: { dev: 'make serve', test: 'make test' } } }
    const applied = effectiveProjectSettings({ ...project, runCommands: { test: 'npm test' } })
    expect(applied.runCommands).toEqual({ dev: 'make serve', test: 'npm test' })
    expect(projectFileContents({ runCommands: { test: 'npm test', dev: '' } })).toBe(
      '{\n  "runCommands": {\n    "test": "npm test"\n  }\n}\n'
    )
  })
})

describe('a run pane', () => {
  it('is found by its kind in its worktree, never by its name', () => {
    const panes = [
      pane('a', { label: 'test' }),
      pane('b', { run: 'test', worktreeId: 'w2' }),
      pane('c', { run: 'test' })
    ]
    expect(runPaneOf(panes, 'w1', 'test')?.id).toBe('c')
    expect(runPaneOf(panes, 'w1', 'dev')).toBeUndefined()
  })

  it('reads pass, fail and stop off the exit code', () => {
    expect(runState({ running: true })).toBe('running')
    expect(runState({ running: false, exitCode: 0 })).toBe('passed')
    expect(runState({ running: false, exitCode: 1 })).toBe('failed')
    expect(runState({ running: false, exitCode: 130 })).toBe('stopped')
    expect(runState({ running: false })).toBe('failed')
  })
})
