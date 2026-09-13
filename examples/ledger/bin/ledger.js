#!/usr/bin/env node
// The command line front end. Reads one ledger file and says who pays whom.

import { readFileSync } from 'node:fs'
import { balances, settle, totalCents } from '../src/settle.js'
import { formatBalances, formatTransfers } from '../src/format.js'
import { LedgerError, parseLedger } from '../src/parse.js'

const USAGE = 'usage: ledger <file.ledger>'

function main(argv) {
  const [path] = argv
  if (path === undefined || path === '--help' || path === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return path === undefined ? 2 : 0
  }

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    process.stderr.write(`ledger: cannot read ${path}: ${error.message}\n`)
    return 1
  }

  let ledger
  try {
    ledger = parseLedger(text)
  } catch (error) {
    // A parse failure names the file as well as the line, because the person
    // reading this has usually just run it over the wrong one.
    if (error instanceof LedgerError) {
      process.stderr.write(`ledger: ${path}: ${error.message}\n`)
      return 1
    }
    throw error
  }

  const rows = balances(ledger.entries)
  const drift = totalCents(rows)
  if (drift !== 0) {
    process.stderr.write(`ledger: balances are off by ${drift} cents, which is a bug in this program\n`)
    return 70
  }

  process.stdout.write(`${ledger.title}\n\n${formatBalances(rows)}\n\n${formatTransfers(settle(rows))}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
