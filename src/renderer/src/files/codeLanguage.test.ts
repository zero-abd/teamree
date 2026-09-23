import { describe, expect, it } from 'vitest'
import { languageFor, loadLanguage } from './codeLanguage'

describe('languageFor', () => {
  it('picks a grammar by extension or by a well-known name', () => {
    expect(languageFor('src/App.tsx')?.name).toBe('TSX')
    expect(languageFor('src/main/index.ts')?.name).toBe('TypeScript')
    expect(languageFor('tool.py')?.name).toBe('Python')
    expect(languageFor('lib.rs')?.name).toBe('Rust')
    expect(languageFor('go.mod.go')?.name).toBe('Go')
    expect(languageFor('package.json')?.name).toBe('JSON')
    expect(languageFor('styles/a.css')?.name).toBe('CSS')
    expect(languageFor('build.sh')?.name).toBe('Shell')
    expect(languageFor('Dockerfile')?.name).toBe('Dockerfile')
    expect(languageFor('config.yml')?.name).toBe('YAML')
    expect(languageFor('README.md')?.name).toBe('Markdown')
  })

  it('leaves an unknown name as plain text', async () => {
    expect(languageFor('notes.unknownext')).toBeNull()
    expect(await loadLanguage('notes.unknownext')).toBeNull()
  })

  it('loads the grammar it picked', async () => {
    const support = await loadLanguage('a.ts')
    expect(support?.language.name).toBe('typescript')
  })
})
