// The Mac's text-editing chords, as the bytes shells and agent prompts read for them.

export type EditKey = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

// ⇧↩ is Meta-Return, which Claude Code and Codex read as a newline and zsh inserts as one.
const SHIFT: Readonly<Record<string, string>> = { Enter: '\u001b\r' }

// Readline's line start, line end, kill to start and kill to end.
const COMMAND: Readonly<Record<string, string>> = {
  ArrowLeft: '\u0001',
  ArrowRight: '\u0005',
  Backspace: '\u0015',
  Delete: '\u000b'
}

// Word left and right; with Option as Meta the emulator's own encoding stands.
const OPTION: Readonly<Record<string, string>> = { ArrowLeft: '\u001bb', ArrowRight: '\u001bf' }

/** The bytes a Mac editing chord sends in place of the emulator's encoding, or null to leave the key to it. */
export function macEditBytes(event: EditKey, optionIsMeta: boolean): string | null {
  if (event.isComposing === true || event.ctrlKey) return null
  const { metaKey, altKey, shiftKey } = event
  if (shiftKey && !metaKey && !altKey) return SHIFT[event.key] ?? null
  if (metaKey && !altKey && !shiftKey) return COMMAND[event.key] ?? null
  if (altKey && !metaKey && !shiftKey && !optionIsMeta) return OPTION[event.key] ?? null
  return null
}
