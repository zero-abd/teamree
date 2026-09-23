// What the owner is shown before they let somebody else's keystrokes run.
// Nothing is rendered: a sender who can paint the prompt can paint the answer,
// so every control, C1 and text-reordering character becomes a printable stand-in.

/**
 * How much of a held burst is shown, in rendered characters (one source
 * character can render as six). What is cut off is *said* to be cut off.
 */
export const MAX_PREVIEW_CHARS = 2_000

/** Where a run of held keystrokes is joined, so a burst reads as one line. */
const PREVIEW_ELLIPSIS = '…'

/**
 * Characters that change what the text around them looks like without being
 * seen: `U+202E` reverses the line, a joiner inside `sudo` makes it another word.
 */
function isDeceptive(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    code === 0x061c || // arabic letter mark
    (code >= 0x200b && code <= 0x200f) || // zero-width space through RLM
    (code >= 0x202a && code <= 0x202e) || // the bidi embeddings and overrides
    (code >= 0x2060 && code <= 0x2064) || // word joiner and the invisible operators
    (code >= 0x2066 && code <= 0x2069) || // the bidi isolates
    code === 0xfeff || // byte-order mark
    (code >= 0xfff9 && code <= 0xfffb) // the interlinear annotation marks
  )
}

/** One character, as the owner should see it rather than as a pty would act on it. */
function show(character: string): string {
  const code = character.codePointAt(0) ?? 0
  // Named where they fall: these two are where a paste stops being text and
  // becomes commands.
  if (character === '\r') return '⏎'
  if (character === '\n') return '␊'
  if (character === '\t') return '⇥'
  // Caret notation, which is what a terminal prints for these anyway.
  if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`
  // DEL and the C1 range, which have no caret.
  if (code === 0x7f) return '^?'
  if ((code >= 0x80 && code <= 0x9f) || isDeceptive(code)) return `\\u${code.toString(16).padStart(4, '0')}`
  return character
}

/** What a held burst looks like, and whether the owner is seeing all of it. */
export type WritePreview = { preview: string; clipped: boolean }

/**
 * Renders everything one teammate is holding at one pane into one safe string,
 * joined with nothing between, as the pty would receive it. Iterated by code
 * point so a surrogate pair is never cut in half.
 */
export function previewOf(parts: readonly string[]): WritePreview {
  let preview = ''
  for (const part of parts) {
    for (const character of part) {
      if (preview.length >= MAX_PREVIEW_CHARS) {
        return { preview: preview.slice(0, MAX_PREVIEW_CHARS) + PREVIEW_ELLIPSIS, clipped: true }
      }
      preview += show(character)
    }
  }
  if (preview.length <= MAX_PREVIEW_CHARS) return { preview, clipped: false }
  return { preview: preview.slice(0, MAX_PREVIEW_CHARS) + PREVIEW_ELLIPSIS, clipped: true }
}
