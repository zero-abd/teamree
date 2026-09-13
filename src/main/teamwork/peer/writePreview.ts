// What the owner is shown before they let somebody else's keystrokes run.
//
// This is the one place in the product where bytes a teammate chose are put in
// front of the owner *as a question*, and that inverts the usual terminal
// contract. A pane is a thing output is meant to act on: an escape sequence
// moves the cursor, a carriage return rewinds the line, a bidirectional
// override reverses what the next twenty characters look like. All of that is
// correct inside a pty and all of it is an attack here, because the thing being
// drawn is the prompt asking whether these bytes may run — and a sender who can
// paint the prompt can paint the answer.
//
// So nothing is rendered. Every byte is turned into something printable that
// stands for it:
//
//   * **C0 controls** become caret notation — `^[` for escape, `^C` for
//     interrupt — which is what every terminal already prints for them and
//     what a reader of this codebase would expect to see.
//   * **The two that matter most** get their own names. A return is what turns
//     typing into a command, and a newline is what submits one; `⏎` and `␊`
//     are drawn where they fall so the owner can count the commands in a
//     paste rather than infer them.
//   * **DEL and the C1 range** become `\u00xx`, because there is no caret for
//     them and a blank would be a byte the owner was not shown.
//   * **The characters that reorder or hide text** — the bidi overrides and
//     isolates, the zero-width joiners and spaces, the soft hyphen, the
//     byte-order mark — become `\uXXXX` too. These are the ones that are
//     *printable* in the sense that a font has something for them and hostile
//     in the sense that what the owner reads is not what the bytes say.
//
// Everything else is left exactly as it is, because the owner has to be able to
// read `npm test` as `npm test`. A preview that escaped ordinary text would be
// a preview nobody could check.

/**
 * How much of a held burst is shown.
 *
 * A keystroke is a byte and a paste is sixty-four kilobytes, and the owner is
 * being asked one question either way. Two thousand characters is a long
 * screenful — enough that a command and its arguments are never cut, far short
 * of a modal that scrolls for a minute — and what is cut off is *said* to be
 * cut off rather than quietly dropped: a preview that looked complete and was
 * not would be the same lie as a keystroke that vanished.
 *
 * Counted in rendered characters rather than in source bytes, because it is a
 * bound on what a screen has to hold. One source character can render as six.
 */
export const MAX_PREVIEW_CHARS = 2_000

/** Where a run of held keystrokes is joined, so a burst reads as one line. */
const PREVIEW_ELLIPSIS = '…'

/**
 * Characters that change what the text around them looks like without being
 * seen themselves.
 *
 * The bidi controls are the famous half — `U+202E` reverses the rest of the
 * line, which is how `rm -rf /` gets to look like a file name — and the
 * zero-width and formatting characters are the quiet half: a joiner between two
 * letters of `sudo` is invisible and makes the word something else. Both kinds
 * are named rather than printed, because the owner's whole job at this prompt
 * is to read the bytes.
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
  // Named where they fall, because these two are where a paste stops being text
  // and becomes commands. Counting them is how an owner tells "they typed a
  // word" from "they submitted four things".
  if (character === '\r') return '⏎'
  if (character === '\n') return '␊'
  if (character === '\t') return '⇥'
  // Caret notation, which is what a terminal prints for these anyway: escape is
  // `^[`, and the rest follow from the same offset.
  if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`
  // DEL and the C1 range, which have no caret between them: `^?` is what a
  // terminal prints for the first, and the rest have nothing to print at all.
  if (code === 0x7f) return '^?'
  if ((code >= 0x80 && code <= 0x9f) || isDeceptive(code)) return `\\u${code.toString(16).padStart(4, '0')}`
  return character
}

/** What a held burst looks like, and whether the owner is seeing all of it. */
export type WritePreview = { preview: string; clipped: boolean }

/**
 * Renders everything one teammate is holding at one pane into one safe string.
 *
 * The parts arrive as they were sent — one per keystroke for somebody typing,
 * one large one for a paste — and are joined with nothing between them, because
 * that is how the pty would have received them. What the owner reads is the
 * sentence that would have been run, not a list of fragments of it.
 *
 * Iterated by code point rather than by UTF-16 unit so that a surrogate pair is
 * one character and is never cut in half; half an emoji is a replacement
 * character on the owner's screen, which is a byte they were shown wrongly.
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
