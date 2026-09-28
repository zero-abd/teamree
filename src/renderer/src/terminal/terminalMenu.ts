// The menu a right-click on a terminal opens: its rows for what is under the pointer, what each does,
// and when the right-click is the program's instead.

import type { Terminal as XTerm } from '@xterm/xterm'
import type { IconName } from '../icons/Icon'
import { formatChord, type PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint, type WorkspaceCommand } from '../keyboard/workspaceShortcuts'
import { anchorAtPointer, type RowMenuAnchor } from '../sidebar/RowMenu'

/** A URL or a worktree file under the pointer, as the pane's link layer found it. */
export type Pointed =
  | { kind: 'link'; uri: string }
  | { kind: 'path'; worktreeId: string; path: string; absolute: string; line?: number; column?: number }

export type TerminalMenuContext = {
  /** A teammate's pane: nothing in the menu may type into it. */
  readOnly: boolean
  hasSelection: boolean
  pointed: Pointed | null
  /** Something is typed at the prompt, which ⌘A selects first. */
  hasInput?: boolean
}

export type TerminalMenuAction =
  | 'open-link'
  | 'copy-link'
  | 'open-path'
  | 'copy-path'
  | 'reveal-path'
  | 'copy'
  | 'paste'
  | 'select-input'
  | 'select-all'
  | 'clear'
  | 'find'
  | 'split-right'
  | 'split-down'

export type TerminalMenuEntry = {
  action: TerminalMenuAction
  label: string
  icon?: IconName
  hint?: string
  disabled?: boolean
  separated?: boolean
}

export function terminalMenuEntries(context: TerminalMenuContext, modifier: PlatformModifier): TerminalMenuEntry[] {
  // The clipboard chords are the pane's only where the modifier is ⌘; elsewhere Ctrl+C is the interrupt.
  const clipboard = (key: string): string | undefined =>
    modifier.eventFlag === 'metaKey' ? formatChord({ key }, modifier) : undefined
  const hint = (command: WorkspaceCommand): string | undefined => shortcutHint(command, modifier) || undefined
  const copy: TerminalMenuEntry = {
    action: 'copy',
    label: 'Copy',
    icon: 'copy',
    hint: clipboard('c'),
    disabled: !context.hasSelection
  }
  const selectAll: TerminalMenuEntry = { action: 'select-all', label: 'Select All', hint: clipboard('a') }
  const selectInput: TerminalMenuEntry[] =
    context.hasInput === true ? [{ action: 'select-input', label: 'Select Input', hint: clipboard('a') }] : []
  const pointed: TerminalMenuEntry[] =
    context.pointed?.kind === 'link'
      ? [
          { action: 'open-link', label: 'Open Link' },
          { action: 'copy-link', label: 'Copy Link' }
        ]
      : context.pointed?.kind === 'path'
        ? [
            { action: 'open-path', label: 'Open File' },
            { action: 'copy-path', label: 'Copy Path' },
            { action: 'reveal-path', label: 'Reveal in Finder', icon: 'reveal' }
          ]
        : []
  if (context.readOnly) return [...pointed, { ...copy, separated: pointed.length > 0 }, selectAll]
  return [
    ...pointed,
    { ...copy, separated: pointed.length > 0 },
    { action: 'paste', label: 'Paste', hint: clipboard('v') },
    ...selectInput,
    selectInput.length > 0 ? { action: 'select-all', label: 'Select All' } : selectAll,
    { action: 'clear', label: 'Clear', hint: hint('clear-pane') },
    { action: 'find', label: 'Find…', icon: 'search', hint: hint('find-in-pane') },
    { action: 'split-right', label: 'Split Right', icon: 'split-right', hint: hint('split-right'), separated: true },
    { action: 'split-down', label: 'Split Down', icon: 'split-down', hint: hint('split-down') }
  ]
}

/** Whether the program asked for mouse reports, right button included. */
export function reportsMouse(term: Pick<XTerm, 'modes'>): boolean {
  return term.modes.mouseTrackingMode !== 'none'
}

/**
 * A program reporting the mouse owns the right-click, except over a link or with the key that forces
 * a selection past it: ⌥ on macOS, Shift elsewhere. Pass `mouseReporting` false over a link.
 */
export function rightClickOpensMenu(
  event: { altKey: boolean; shiftKey: boolean },
  mouseReporting: boolean,
  modifier: PlatformModifier
): boolean {
  if (!mouseReporting) return true
  return modifier.eventFlag === 'metaKey' ? event.altKey : event.shiftKey
}

/** Keeps a right-click that opens the menu from reaching the program as a mouse report; returns the undo. */
export function holdRightClickFromProgram(
  element: HTMLElement,
  reporting: () => boolean,
  modifier: PlatformModifier,
  onPress: () => void,
  overLink: (event: MouseEvent) => boolean = () => false
): () => void {
  // Capture on the host runs before xterm's own listeners below it.
  const hold = (event: MouseEvent): void => {
    if (event.button !== 2 || !reporting()) return
    if (!rightClickOpensMenu(event, true, modifier) && !overLink(event)) return
    event.stopPropagation()
    if (event.type === 'mousedown') onPress()
  }
  element.addEventListener('mousedown', hold, true)
  element.addEventListener('mouseup', hold, true)
  return () => {
    element.removeEventListener('mousedown', hold, true)
    element.removeEventListener('mouseup', hold, true)
  }
}

/** At the pointer; a key-raised menu has none and hangs from the pane's corner. */
export function menuAnchor(event: {
  clientX: number
  clientY: number
  currentTarget: { getBoundingClientRect: () => DOMRect }
}): RowMenuAnchor {
  if (event.clientX !== 0 || event.clientY !== 0) return anchorAtPointer(event.clientX, event.clientY)
  const box = event.currentTarget.getBoundingClientRect()
  return anchorAtPointer(box.left + 8, box.top + 8)
}

/** What the rows act on. */
export type TerminalMenuHost = {
  term: Pick<XTerm, 'getSelection' | 'selectAll' | 'paste'>
  /** Clears the pane for every reader, not only this emulator. */
  clear: () => void
  clipboard: { copy: (text: string) => void; read: () => Promise<string> }
  /** Vouches for a paste as typing. See `handsHere.ts`. */
  byHand?: () => void
  openLink: (uri: string) => void
  /** Copies a link or a path. */
  copyLink: (text: string) => void
  openPath: (pointed: Extract<Pointed, { kind: 'path' }>) => void
  reveal: (absolute: string, path: string) => void
  find: () => void
  split: (direction: 'row' | 'column') => void
  /** False when the input has gone since the menu opened; Select All stands in. */
  selectInput?: () => boolean
}

export function runTerminalMenuAction(
  action: TerminalMenuAction,
  pointed: Pointed | null,
  host: TerminalMenuHost
): void {
  switch (action) {
    case 'open-link':
    case 'copy-link':
      if (pointed?.kind !== 'link') return
      if (action === 'open-link') host.openLink(pointed.uri)
      else host.copyLink(pointed.uri)
      return
    case 'open-path':
      if (pointed?.kind === 'path') host.openPath(pointed)
      return
    case 'copy-path':
      if (pointed?.kind === 'path') host.copyLink(pointed.absolute)
      return
    case 'reveal-path':
      if (pointed?.kind === 'path') host.reveal(pointed.absolute, pointed.path)
      return
    case 'copy':
      host.clipboard.copy(host.term.getSelection())
      return
    case 'paste':
      pasteFromClipboard(host.term, host.clipboard, host.byHand)
      return
    case 'select-input':
      if (host.selectInput?.() !== true) host.term.selectAll()
      return
    case 'select-all':
      host.term.selectAll()
      return
    case 'clear':
      host.clear()
      return
    case 'find':
      host.find()
      return
    case 'split-right':
      host.split('row')
      return
    case 'split-down':
      host.split('column')
  }
}

/** Through the emulator, whose `paste` adds the bracketed-paste markers the program asked for. */
export function pasteFromClipboard(
  term: Pick<XTerm, 'paste'>,
  clipboard: { read: () => Promise<string> },
  byHand?: () => void
): void {
  void clipboard.read().then((text) => {
    if (text === '') return
    try {
      byHand?.()
      term.paste(text)
    } catch {
      // The clipboard read takes a turn of the loop; the pane may have closed underneath it.
    }
  })
}
