// Who owes whom, and the shortest list of payments that ends it.

/**
 * Splits `cents` between `count` people so that the parts sum back to exactly
 * `cents`. Division leaves a remainder of at most `count - 1` cents, and it has
 * to land on somebody: the first few participants in the entry's own order each
 * carry one extra cent. Spreading it by name or at random would make two runs
 * over the same ledger disagree about a penny, which is exactly the kind of
 * difference that costs an afternoon.
 */
export function splitShares(cents, count) {
  const base = Math.floor(cents / count)
  const remainder = cents - base * count
  return Array.from({ length: count }, (_unused, index) => base + (index < remainder ? 1 : 0))
}

/**
 * Net position per person, in cents: positive means the group owes them, and
 * negative means they owe the group. Sorted by name so the output of two runs
 * can be diffed.
 */
export function balances(entries) {
  const net = new Map()
  const bump = (person, cents) => net.set(person, (net.get(person) ?? 0) + cents)

  for (const entry of entries) {
    bump(entry.payer, entry.cents)
    const shares = splitShares(entry.cents, entry.shared.length)
    entry.shared.forEach((person, index) => bump(person, -shares[index]))
  }

  return [...net.entries()]
    .map(([person, cents]) => ({ person, cents }))
    .sort((left, right) => left.person.localeCompare(right.person))
}

/**
 * Turns balances into transfers: repeatedly pay the largest debt from the
 * largest credit. Greedy is not provably the minimum number of transfers — that
 * problem is NP-hard — but it never needs more than one transfer per person
 * minus one, which is the property that matters when a human has to make them.
 *
 * Ties are broken by name, so the answer is stable run to run.
 */
export function settle(balanceRows) {
  const creditors = balanceRows.filter((row) => row.cents > 0).map((row) => ({ ...row }))
  const debtors = balanceRows.filter((row) => row.cents < 0).map((row) => ({ ...row, cents: -row.cents }))

  const byWeight = (left, right) => right.cents - left.cents || left.person.localeCompare(right.person)
  creditors.sort(byWeight)
  debtors.sort(byWeight)

  const transfers = []
  let credit = 0
  let debt = 0
  while (credit < creditors.length && debt < debtors.length) {
    const amount = Math.min(creditors[credit].cents, debtors[debt].cents)
    transfers.push({ from: debtors[debt].person, to: creditors[credit].person, cents: amount })
    creditors[credit].cents -= amount
    debtors[debt].cents -= amount
    if (creditors[credit].cents === 0) credit += 1
    if (debtors[debt].cents === 0) debt += 1
  }

  return transfers
}

/**
 * Every balance list must sum to zero: each entry credits exactly what it
 * debits. A non-zero total means the arithmetic above is wrong, not that the
 * ledger is, so the CLI checks it and says so rather than printing a settlement
 * nobody should trust.
 */
export function totalCents(balanceRows) {
  return balanceRows.reduce((sum, row) => sum + row.cents, 0)
}
