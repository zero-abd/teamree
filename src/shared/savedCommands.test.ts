import { describe, expect, it } from 'vitest'
import type { Project, SavedCommand } from './entities'
import { projectFileContents, effectiveProjectSettings } from './projectSettings'
import { savedCommandsOf } from './savedCommands'

const BASE: Project = { id: 'p', name: 'pantry', path: '/repos/pantry', baseRef: 'origin/main' }
const lint: SavedCommand = { id: 'c1', label: 'Lint', text: 'npm run lint', kind: 'shell', where: 'new' }
const review: SavedCommand = { id: 'c2', label: 'Review', text: 'Review the diff', kind: 'agent', where: 'current' }
const migrate: SavedCommand = { id: 'c3', label: 'Migrate', text: 'npm run db:migrate', kind: 'shell', where: 'new' }

describe('savedCommandsOf', () => {
  it('lists this project’s, then the repository’s, then every project’s', () => {
    const project = { ...BASE, savedCommands: [lint], repository: { savedCommands: [migrate] } }
    expect(savedCommandsOf(project, [review])).toEqual([
      { command: lint, source: 'project', approved: true },
      { command: migrate, source: 'repository', approved: false },
      { command: review, source: 'everywhere', approved: true }
    ])
    expect(savedCommandsOf(undefined, [review])).toEqual([{ command: review, source: 'everywhere', approved: true }])
  })

  it('runs a repository command unasked once this Mac approved exactly its text', () => {
    const project = { ...BASE, repository: { savedCommands: [migrate] }, approvedSavedCommands: [migrate.text] }
    expect(savedCommandsOf(project)[0]?.approved).toBe(true)
    const changed = { ...project, repository: { savedCommands: [{ ...migrate, text: 'npm run db:reset' }] } }
    expect(savedCommandsOf(changed)[0]?.approved).toBe(false)
  })

  it('shows a repository command this Mac also keeps once, as its own', () => {
    const project = { ...BASE, savedCommands: [lint], repository: { savedCommands: [lint, migrate] } }
    expect(savedCommandsOf(project).map((offer) => offer.source)).toEqual(['project', 'repository'])
  })
})

describe('saved commands in the project file', () => {
  it('writes this Mac’s and the repository’s together, one per id', () => {
    const project = {
      ...BASE,
      savedCommands: [lint],
      repository: { savedCommands: [{ ...lint, text: 'old' }, migrate] }
    }
    expect(effectiveProjectSettings(project).savedCommands).toEqual([lint, migrate])
    expect(JSON.parse(projectFileContents({ savedCommands: [lint] }))).toEqual({ savedCommands: [lint] })
    expect(projectFileContents({ savedCommands: [] })).toBe('{}\n')
  })
})
