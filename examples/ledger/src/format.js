// Turning cents back into something a person reads.

/** 4260 becomes "42.60", -5 becomes "-0.05". Always two decimal places. */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const magnitude = Math.abs(cents)
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`
}

/**
 * Balances as a table, amounts right-aligned on the decimal point. Padding is
 * computed from the widest row rather than a fixed column, because a ledger with
 * a four-figure total and one with a two-figure total should both read straight.
 */
export function formatBalances(balanceRows) {
  if (balanceRows.length === 0) return 'Nobody has spent anything yet.'

  const cells = balanceRows.map((row) => ({
    name: row.person,
    verdict: row.cents > 0 ? 'is owed' : row.cents < 0 ? 'owes' : 'is square',
    // The magnitude, not the signed value: "owes" already carries the sign, and
    // "owes -18.10" reads as the opposite of what it means.
    amount: row.cents === 0 ? '' : formatCents(Math.abs(row.cents))
  }))

  // "is owed" and "owes" are different widths, so the verdict is a padded column
  // of its own; otherwise the amounts beside them never line up.
  const nameWidth = Math.max(...cells.map((cell) => cell.name.length))
  const verdictWidth = Math.max(...cells.map((cell) => cell.verdict.length))
  const amountWidth = Math.max(...cells.map((cell) => cell.amount.length))

  return cells
    .map((cell) =>
      `${cell.name.padEnd(nameWidth)}  ${cell.verdict.padEnd(verdictWidth)}  ${cell.amount.padStart(amountWidth)}`.trimEnd()
    )
    .join('\n')
}

/** The payments themselves, one per line. */
export function formatTransfers(transfers) {
  if (transfers.length === 0) return 'Everyone is square; no payments needed.'
  return transfers.map((transfer) => `${transfer.from} pays ${transfer.to} ${formatCents(transfer.cents)}`).join('\n')
}
