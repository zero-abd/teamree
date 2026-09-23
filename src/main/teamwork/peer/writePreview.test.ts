// What the owner reads before they let somebody else's bytes run: the boundary
// that decides whether the question can be painted by the person it is about.

import { describe, expect, it } from 'vitest'
import { MAX_PREVIEW_CHARS, previewOf } from './writePreview'

describe('a held burst is shown as text and never as terminal instructions', () => {
  it('leaves an ordinary command exactly as it was typed', () => {
    // The half that makes the prompt worth reading: `npm test` recognisable at a glance.
    expect(previewOf(['npm test'])).toEqual({ preview: 'npm test', clipped: false })
  })

  it('joins the keystrokes of a burst into the line they would have made', () => {
    expect(previewOf([...'ls -la', '\r']).preview).toBe('ls -la⏎')
  })

  it('draws the marks that turn typing into commands, rather than obeying them', () => {
    // Counting these is how an owner tells "they typed a word" from "they
    // submitted four things", so each gets a mark of its own.
    expect(previewOf(['a\rb\nc\td']).preview).toBe('a⏎b␊c⇥d')
  })

  it('shows an escape sequence instead of running it', () => {
    // `\u001b[2J` clears the screen and `\u001b[H` homes the cursor: together
    // they are how a prompt gets repainted by the thing it is asking about.
    expect(previewOf(['\u001b[2J\u001b[Hnothing to see']).preview).toBe('^[[2J^[[Hnothing to see')
  })

  it('names the characters that make text read as something else', () => {
    // The right-to-left override: everything after it reads backwards.
    expect(previewOf(['\u202erm -rf /']).preview).toBe('\\u202erm -rf /')
    // And the invisible ones, which do it by hiding rather than by reversing.
    expect(previewOf(['su\u200bdo']).preview).toBe('su\\u200bdo')
    expect(previewOf(['\ufeffgit push']).preview).toBe('\\ufeffgit push')
  })

  it('shows a control character with no name in caret notation', () => {
    expect(previewOf(['\u0003']).preview).toBe('^C')
    expect(previewOf(['\u0000']).preview).toBe('^@')
    expect(previewOf(['\u007f']).preview).toBe('^?')
  })

  it('keeps non-ASCII text that is merely non-ASCII', () => {
    // A branch name in Japanese is not an attack, and neither is an emoji.
    expect(previewOf(['git switch 機能/検索 🚀']).preview).toBe('git switch 機能/検索 🚀')
  })

  it('says so when there is more held than it is showing', () => {
    const long = previewOf(['x'.repeat(MAX_PREVIEW_CHARS * 2)])
    expect(long.clipped).toBe(true)
    expect(long.preview.length).toBe(MAX_PREVIEW_CHARS + 1)
    // A preview that looked complete and was not would be the same lie as a
    // keystroke that vanished.
    expect(long.preview.endsWith('…')).toBe(true)
  })

  it('never cuts a character in half', () => {
    // One emoji is two UTF-16 units, and half of one is a replacement
    // character — a byte the owner was shown wrongly rather than not at all.
    const preview = previewOf(['🚀'.repeat(MAX_PREVIEW_CHARS)]).preview
    expect(preview).not.toContain('�')
  })
})
