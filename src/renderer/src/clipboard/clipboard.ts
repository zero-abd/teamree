// The two directions of the system clipboard, in one place.
//
// It was one direction and it lived in `TeamworkView.tsx`, because an invitation
// nobody can copy is an invitation nobody can accept. A pane needs the same
// thing for the URL an agent just printed, and the subtlety it needs is the one
// that was already written down there: **the async clipboard API needs a secure
// context, and a renderer loaded from a `file:` URL in a packaged build is not
// reliably one.** A second copy of this that reached straight for
// `navigator.clipboard` would work in the dev server and fail in the build,
// which is the worst way for a thing like this to be wrong.
//
// Reading has no fallback and that is not an oversight. The old
// selection-and-`execCommand` trick can put text on the clipboard; Chromium has
// never let a page take text off it that way. So a read that cannot happen
// answers with nothing, and the caller is left to do nothing — see `pasteText`.

/**
 * Puts text on the clipboard, by whichever of the two ways is available.
 *
 * There is nothing to report back. A copy that fails both ways leaves the text
 * where it already was, which for both callers is on the screen.
 */
export function copyText(text: string): void {
  const async = navigator.clipboard?.writeText(text)
  if (async !== undefined) {
    void async.catch(() => selectAndCopy(text))
    return
  }
  selectAndCopy(text)
}

/**
 * Takes text off the clipboard, or answers with nothing.
 *
 * `''` for every way this can fail — no clipboard API, no permission, an image
 * on the clipboard — because every caller's answer to all of them is the same:
 * paste nothing.
 */
export async function pasteText(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? ''
  } catch {
    return ''
  }
}

function selectAndCopy(text: string): void {
  const field = document.createElement('textarea')
  field.value = text
  // Off-screen rather than hidden: a `display: none` element cannot be selected,
  // which is the whole mechanism this depends on.
  field.style.position = 'fixed'
  field.style.left = '-9999px'
  document.body.append(field)
  field.select()
  try {
    document.execCommand('copy')
  } catch {
    // Nothing to do and nothing to say. The text is on screen either way.
  }
  field.remove()
}
