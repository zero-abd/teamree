// The asking cards on screen, by pane, so a keyboard jump to an asking pane lands on its first answer.

import { focusRegion, regionAfter } from '../shell/regions'

const cards = new Map<string, HTMLElement>()

/** Registers a drawn card; the returned function unregisters that one only. */
export function registerAskCard(terminalId: string, card: HTMLElement): () => void {
  cards.set(terminalId, card)
  return () => {
    if (cards.get(terminalId) === card) cards.delete(terminalId)
  }
}

/** Focuses the first answer of the pane's card; false when it has none drawn. */
export function focusAskAnswer(terminalId: string): boolean {
  const answer = cards.get(terminalId)?.querySelector<HTMLButtonElement>('.pane-state__actions button')
  if (answer === null || answer === undefined) return false
  answer.focus()
  return true
}

/** After an answer: the pane's terminal, else the focused pane, else the first region that can take the keyboard. */
export function focusAfterAnswer(pane: Element | null): void {
  const input = pane?.isConnected ? pane.querySelector<HTMLElement>('.xterm-helper-textarea') : null
  input?.focus()
  if (input && document.activeElement === input) return
  if (focusRegion('panes')) return
  const next = regionAfter(null, 1)
  if (next !== null) focusRegion(next)
}
