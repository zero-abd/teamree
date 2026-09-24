import { describe, expect, it } from 'vitest'
import type { Project } from './entities'
import { effectiveProjectSettings, projectFileContents, settingSource, startPointOf } from './projectSettings'

const BASE: Project = { id: 'p', name: 'pantry', path: '/repos/pantry', baseRef: 'origin/main' }

describe('which value applies on this Mac', () => {
  it('prefers this Mac, then the repository, then nothing', () => {
    const repository = { setupCommand: 'npm ci', copiedPaths: ['.env'], linkedPaths: ['node_modules'] }
    expect(effectiveProjectSettings(BASE)).toEqual({})
    expect(effectiveProjectSettings({ ...BASE, repository })).toEqual(repository)
    expect(
      effectiveProjectSettings({ ...BASE, repository, setupCommand: 'pnpm i', copiedPaths: ['.env.local'] })
    ).toEqual({
      setupCommand: 'pnpm i',
      copiedPaths: ['.env.local'],
      linkedPaths: ['node_modules']
    })
  })

  it('starts worktrees from this Mac’s ref, then the repository’s, then the base ref', () => {
    expect(startPointOf(BASE, undefined)).toBe('origin/main')
    expect(startPointOf({ ...BASE, repository: { startFrom: 'origin/dev' } }, '')).toBe('origin/dev')
    expect(startPointOf({ ...BASE, repository: { startFrom: 'origin/dev' } }, 'main')).toBe('main')
  })

  it('calls a value an override only when the repository says something else', () => {
    expect(settingSource('npm ci', undefined)).toBeNull()
    expect(settingSource(undefined, 'npm ci')).toBe('repository')
    expect(settingSource('npm ci', 'npm ci')).toBe('repository')
    expect(settingSource('pnpm i', 'npm ci')).toBe('local')
    expect(settingSource(['.env'], ['.env'])).toBe('repository')
  })
})

describe('the file written by Save to Repository', () => {
  it('leaves out what is empty and ends in a newline', () => {
    expect(projectFileContents({ setupCommand: 'npm ci', linkedPaths: [], copiedPaths: ['.env'] })).toBe(
      '{\n  "setupCommand": "npm ci",\n  "copiedPaths": [\n    ".env"\n  ]\n}\n'
    )
  })
})
