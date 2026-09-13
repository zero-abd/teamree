import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LedgerError, parseLedger, toCents } from '../src/parse.js'

test('reads the title from the header', () => {
  const ledger = parseLedger('title: Weekend in the hills\n')
  assert.equal(ledger.title, 'Weekend in the hills')
  assert.deepEqual(ledger.entries, [])
})

test('a ledger with no header still parses', () => {
  const ledger = parseLedger('2024-03-01 | ana | 10.00 | ana bo | tea\n')
  assert.equal(ledger.title, 'Untitled ledger')
  assert.equal(ledger.entries.length, 1)
})

test('reads every field of an entry', () => {
  const [entry] = parseLedger('2024-03-01 | ana | 42.60 | ana bo cy | groceries, mostly\n').entries
  assert.deepEqual(entry, {
    date: '2024-03-01',
    payer: 'ana',
    cents: 4260,
    shared: ['ana', 'bo', 'cy'],
    description: 'groceries, mostly',
    line: 1
  })
})

test('ignores blank lines and comments, including trailing ones', () => {
  const ledger = parseLedger(['# a trip', '', '2024-03-01 | ana | 1.00 | ana | tea # the good stuff', ''].join('\n'))
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.entries[0].description, 'tea')
})

test('an amount without decimals is whole units', () => {
  assert.equal(toCents('42'), 4200)
  assert.equal(toCents('42.6'), 4260)
  assert.equal(toCents('42.60'), 4260)
  assert.equal(toCents('0.05'), 5)
})

test('line numbers survive comments and blanks above them', () => {
  const text = ['# note', '', 'title: trip', '', '2024-03-01 | ana | oops | ana | tea'].join('\n')
  assert.throws(
    () => parseLedger(text),
    (error) => error instanceof LedgerError && error.line === 5
  )
})

test('refuses an unknown header rather than ignoring it', () => {
  assert.throws(() => parseLedger('titel: trip\n'), /unknown header "titel"/)
})

test('refuses a header that comes after an entry', () => {
  const text = ['2024-03-01 | ana | 1.00 | ana | tea', 'title: too late'].join('\n')
  assert.throws(() => parseLedger(text), /must come before the first entry/)
})

test('refuses the wrong number of fields', () => {
  assert.throws(() => parseLedger('2024-03-01 | ana | 1.00 | ana\n'), /found 4/)
})

test('refuses a date that is not a date', () => {
  assert.throws(() => parseLedger('1st March | ana | 1.00 | ana | tea\n'), /not a date/)
})

test('refuses an amount with three decimal places', () => {
  assert.throws(() => parseLedger('2024-03-01 | ana | 1.005 | ana | tea\n'), /not an amount/)
})

test('refuses an entry of nothing', () => {
  assert.throws(() => parseLedger('2024-03-01 | ana | 0.00 | ana | tea\n'), /changes nothing/)
})

test('refuses an entry nobody shared', () => {
  assert.throws(() => parseLedger('2024-03-01 | ana | 1.00 |  | tea\n'), /at least one participant/)
})

test('refuses the same participant twice, which would halve their share', () => {
  assert.throws(() => parseLedger('2024-03-01 | ana | 1.00 | ana ana | tea\n'), /"ana" is listed twice/)
})

test('refuses an entry with no description', () => {
  assert.throws(() => parseLedger('2024-03-01 | ana | 1.00 | ana |\n'), /needs a description/)
})
