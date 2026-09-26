import { describe, expect, it } from 'vitest'
import { copyName, notePayload, noteTitle } from './shareNote'

describe('what a shared note carries', () => {
  it('leaves local images out as their alt text and counts them', () => {
    const sent = notePayload('Before ![diagram](./img/flow.png) and ![](shot.png "x") after')
    expect(sent.markdown).toBe('Before \\[image: diagram\\] and \\[image\\] after')
    expect(sent.imagesLeftOut).toBe(2)
  })

  it('leaves file: links out too, and keeps a remote image as text', () => {
    const sent = notePayload('![a](file:///Users/me/a.png)\n![b](https://example.com/b.png)')
    expect(sent.markdown).toBe('\\[image: a\\]\n![b](https://example.com/b.png)')
    expect(sent.imagesLeftOut).toBe(1)
  })

  it('does not touch image syntax inside a code fence', () => {
    const text = '```md\n![x](local.png)\n```\n![y](local.png)'
    expect(notePayload(text)).toEqual({ markdown: '```md\n![x](local.png)\n```\n\\[image: y\\]', imagesLeftOut: 1 })
  })

  it('takes the first heading as the title, else the file name', () => {
    expect(noteTitle('intro\n# Release plan #\n\n## Later', 'notes/NOTES.md')).toBe('Release plan')
    expect(noteTitle('no heading here', 'notes/standup.md')).toBe('standup')
  })
})

describe('the name a saved copy gets', () => {
  it('is the title as a markdown file, numbered when taken', () => {
    expect(copyName('Release plan')).toBe('Release plan.md')
    expect(copyName('Release plan', 1)).toBe('Release plan 2.md')
  })

  it('cannot leave the worktree root or hide itself', () => {
    expect(copyName('../../etc/passwd')).toBe('etc passwd.md')
    expect(copyName('a/b\\c:d')).toBe('a b c d.md')
    expect(copyName('...')).toBe('Shared note.md')
  })
})
