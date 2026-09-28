// The asking cards on screen, by pane, so a keyboard jump to an asking pane lands on its first answer.

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
