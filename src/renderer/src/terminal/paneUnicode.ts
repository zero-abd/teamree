import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Terminal as XTerm } from '@xterm/xterm'

/** Unicode 11 widths, so emoji take the two cells programs count them as. Call before the first write. */
export function wideEmoji(term: XTerm): void {
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
}
