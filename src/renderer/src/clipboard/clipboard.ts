// Both directions of the system clipboard. The async API needs a secure context, which a packaged
// `file:` renderer is not reliably, so writes fall back to `execCommand`; reads have no fallback.

/** Puts text on the clipboard by whichever way works; a failure leaves the text on screen. */
export function copyText(text: string): void {
  const async = navigator.clipboard?.writeText(text)
  if (async !== undefined) {
    void async.catch(() => selectAndCopy(text))
    return
  }
  selectAndCopy(text)
}

/** Takes text off the clipboard, or `''` for every failure, since every caller then pastes nothing. */
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
  // Off-screen, not `display: none`, which cannot be selected.
  field.style.position = 'fixed'
  field.style.left = '-9999px'
  document.body.append(field)
  field.select()
  try {
    document.execCommand('copy')
  } catch {
    // The text is on screen either way.
  }
  field.remove()
}
