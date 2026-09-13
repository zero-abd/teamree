// The ledger file format, turned into entries.
//
// Amounts become an integer number of cents here and stay that way for the rest
// of the program. A ledger that balances to the penny in decimal does not
// balance in binary floating point, and "ana is owed 0.30000000000000004" is
// the class of bug this file exists to prevent.

/** A parse failure that knows which line it came from, so the CLI can say. */
export class LedgerError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `line ${line}: ${message}`)
    this.name = 'LedgerError'
    this.line = line
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT = /^\d+(?:\.\d{1,2})?$/
const NAME = /^[a-z][a-z0-9-]*$/

/**
 * Header keys we understand. An unknown key is an error rather than a shrug: a
 * misspelled `titel:` that silently does nothing is worse than a refusal.
 */
const HEADERS = new Set(['title'])

/**
 * Parses `text` into `{ title, entries }`.
 *
 * Entries are pipe-separated so that a description may contain spaces without
 * anyone having to invent quoting rules:
 *
 *     date | payer | amount | participants | description
 *     2024-03-01 | ana | 42.60 | ana bo cy | groceries
 *
 * Throws `LedgerError` on any line that is not one of those two shapes.
 */
export function parseLedger(text) {
  let title = 'Untitled ledger'
  const entries = []
  let seenEntry = false

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = stripComment(lines[index]).trim()
    if (line === '') continue

    if (!line.includes('|')) {
      const header = parseHeader(line, lineNumber)
      // A header after the first entry would make the title depend on how far
      // you had read, so it is refused rather than quietly applied.
      if (seenEntry) throw new LedgerError(`header "${header.key}" must come before the first entry`, lineNumber)
      title = header.value
      continue
    }

    entries.push(parseEntry(line, lineNumber))
    seenEntry = true
  }

  return { title, entries }
}

/** `#` starts a comment, with no escape for it: no description has needed one. */
function stripComment(line) {
  const hash = line.indexOf('#')
  return hash === -1 ? line : line.slice(0, hash)
}

function parseHeader(line, lineNumber) {
  const colon = line.indexOf(':')
  if (colon === -1) throw new LedgerError('expected "key: value" or a pipe-separated entry', lineNumber)

  const key = line.slice(0, colon).trim().toLowerCase()
  const value = line.slice(colon + 1).trim()
  if (!HEADERS.has(key)) throw new LedgerError(`unknown header "${key}"`, lineNumber)
  if (value === '') throw new LedgerError(`header "${key}" has no value`, lineNumber)
  return { key, value }
}

function parseEntry(line, lineNumber) {
  const fields = line.split('|').map((field) => field.trim())
  if (fields.length !== 5) {
    throw new LedgerError(`expected 5 fields separated by "|", found ${fields.length}`, lineNumber)
  }

  const [date, payer, amount, participants, description] = fields
  if (!DATE.test(date)) throw new LedgerError(`"${date}" is not a date of the form YYYY-MM-DD`, lineNumber)
  if (!NAME.test(payer)) throw new LedgerError(`"${payer}" is not a name`, lineNumber)
  if (!AMOUNT.test(amount)) throw new LedgerError(`"${amount}" is not an amount`, lineNumber)

  const cents = toCents(amount)
  if (cents === 0) throw new LedgerError('an entry of 0 changes nothing, and is more likely a mistake', lineNumber)

  const shared = participants.split(/\s+/).filter((name) => name !== '')
  if (shared.length === 0) throw new LedgerError('an entry needs at least one participant', lineNumber)
  for (const name of shared) {
    if (!NAME.test(name)) throw new LedgerError(`"${name}" is not a name`, lineNumber)
  }
  const duplicate = shared.find((name, at) => shared.indexOf(name) !== at)
  if (duplicate) throw new LedgerError(`"${duplicate}" is listed twice in the same entry`, lineNumber)

  if (description === '') throw new LedgerError('an entry needs a description', lineNumber)

  return { date, payer, cents, shared, description, line: lineNumber }
}

/** "42.6" and "42.60" are both 4260 cents; "42" is 4200. */
export function toCents(amount) {
  const [whole, fraction = ''] = amount.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
