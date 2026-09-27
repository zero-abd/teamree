// A row's chips on one line: what needs you first, the rest folded behind one `+N`.

export type ChipRank = 'asking' | 'conflict' | 'failing' | 'rest'

/** One chip on a row; `text` is its line in the `+N` hover. */
export type RowChip<Node = unknown> = { key: string; rank: ChipRank; text: string; node: Node }

const ORDER: Record<ChipRank, number> = { asking: 0, conflict: 1, failing: 2, rest: 3 }

/** Chips a compact row shows before folding the rest. */
export const COMPACT_CHIPS = 2

/** Ranked, ties in the order given; the first `room` shown, the rest folded. */
export function foldChips<Node>(
  chips: readonly RowChip<Node>[],
  room: number
): { shown: RowChip<Node>[]; folded: RowChip<Node>[] } {
  const ranked = [...chips].sort((a, b) => ORDER[a.rank] - ORDER[b.rank])
  const at = Math.max(0, room)
  return { shown: ranked.slice(0, at), folded: ranked.slice(at) }
}

export function foldTitle(folded: readonly RowChip[]): string {
  return folded.map((chip) => chip.text).join('\n')
}
