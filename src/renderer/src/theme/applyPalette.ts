// Putting a resolved palette on screen.
//
// One function, and it writes inline custom properties onto the root element.
// That is deliberately the crudest mechanism available: an inline declaration
// on `:root` beats the `:root` rule in `tokens.css` by specificity without
// replacing it, so the stylesheet still paints the first frame and still holds
// every token a stylesheet author needs to read, while the stored appearance
// takes over the moment the app mounts.
//
// Nothing else in the renderer sets a colour. Everything downstream — the
// stylesheets, and the emulator through `readTerminalTheme` — reads these back
// off the same element, which is why switching a theme reaches a pane that has
// been running for an hour.

import { THEME_TOKENS, type Palette } from '@shared/theme'

export function applyPalette(root: HTMLElement | null, palette: Palette): void {
  if (!root) return
  for (const token of THEME_TOKENS) root.style.setProperty(`--${token}`, palette[token])
}
