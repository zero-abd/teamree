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

describe('markdown', () => {
  const nodes = async (text: string): Promise<string[]> => {
    const support = await loadLanguage('guide.md')
    const names: string[] = []
    support!.language.parser.parse(text).iterate({ enter: (node) => void names.push(node.name) })
    return names
  }

  it('reads a leading YAML block as front matter, not a rule and a heading', async () => {
    const names = await nodes('---\ntitle: Shop guide\ntags: [shop, docs]\n---\n\n# Shop guide\n')
    expect(names.slice(0, 2)).toEqual(['Document', 'FrontMatter'])
    expect(names.filter((name) => /Setext|HorizontalRule|Link/.test(name))).toEqual([])
    expect(names).toContain('ATXHeading1')
    expect(await nodes('---\ntitle: x\n...\n')).toContain('FrontMatter')
  })

  it('leaves a rule that does not open the file, or opens it before prose, as a rule', async () => {
    expect(await nodes('text\n\n---\ntitle: x\n---\n')).not.toContain('FrontMatter')
    const rule = await nodes('---\n\nSome prose.\n')
    expect(rule).not.toContain('FrontMatter')
    expect(rule).toContain('HorizontalRule')
  })
})
