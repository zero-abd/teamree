import { describe, expect, it } from 'vitest'
import { MAX_NOTE_TITLE_CHARS, MAX_SHARED_NOTE_BYTES, NOTE_TOO_LARGE, SharedNotePayload } from './sharedNote'

const note = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  noteId: 'NOTES.md',
  title: 'Plan',
  markdown: '# Plan\n\n- ship it\n',
  sentAt: 1_700_000_000_000,
  ...overrides
})

describe('a shared note on the wire', () => {
  it('takes a note with an id, a title, a body and a time', () => {
    expect(SharedNotePayload.parse(note())).toEqual(note())
  })

  it('keeps nothing the schema does not name, so a claimed sender is dropped', () => {
    const parsed = SharedNotePayload.parse(note({ handle: 'the-owner', html: '<script>x</script>' }))
    expect(parsed).not.toHaveProperty('handle')
    expect(parsed).not.toHaveProperty('html')
  })

  it.each([
    ['no title', { title: '' }],
    ['a blank title', { title: '   ' }],
    ['a title past the cap', { title: 'x'.repeat(MAX_NOTE_TITLE_CHARS + 1) }],
    ['no note id', { noteId: '' }],
    ['a body that is not text', { markdown: 42 }],
    ['a time that is not an integer', { sentAt: 1.5 }],
    ['a negative time', { sentAt: -1 }]
  ])('refuses %s', (_name, overrides) => {
    expect(SharedNotePayload.safeParse(note(overrides)).success).toBe(false)
  })

  it('takes a note exactly at the cap, title included', () => {
    const markdown = 'a'.repeat(MAX_SHARED_NOTE_BYTES - 'Plan'.length)
    expect(SharedNotePayload.safeParse(note({ markdown })).success).toBe(true)
  })

  it('refuses one byte over, tersely', () => {
    const markdown = 'a'.repeat(MAX_SHARED_NOTE_BYTES - 'Plan'.length + 1)
    const parsed = SharedNotePayload.safeParse(note({ markdown }))
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([NOTE_TOO_LARGE])
  })

  it('counts bytes, not characters: a body of emoji under the character count is still over', () => {
    const markdown = '🙂'.repeat(MAX_SHARED_NOTE_BYTES / 4)
    expect(markdown.length).toBeLessThan(MAX_SHARED_NOTE_BYTES)
    expect(SharedNotePayload.safeParse(note({ markdown })).success).toBe(false)
  })
})
