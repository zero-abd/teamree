// The one way this window reaches the user's browser: `window.open`, which main's window-open handler
// (`windowNavigation.ts`) vets and opens externally. No scheme check here; that would be a second answer.

export function openInBrowser(url: string): void {
  window.open(url, '_blank', 'noopener')
}
