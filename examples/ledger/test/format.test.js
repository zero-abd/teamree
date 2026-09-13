import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatBalances, formatCents, formatTransfers } from '../src/format.js'

test('cents become two decimal places', () => {
  assert.equal(formatCents(4260), '42.60')
  assert.equal(formatCents(5), '0.05')
  assert.equal(formatCents(0), '0.00')
})

test('a negative amount keeps its sign in front of the units', () => {
  assert.equal(formatCents(-5), '-0.05')
  assert.equal(formatCents(-4260), '-42.60')
})

test('balances line up under each other', () => {
  const lines = formatBalances([
    { person: 'ana', cents: 1250 },
    { person: 'bartholomew', cents: -1250 }
  ]).split('\n')
  assert.equal(lines[0], 'ana          is owed  12.50')
  assert.equal(lines[1], 'bartholomew  owes     12.50')
  // The whole point of the padding: the decimal points are in one column.
  assert.equal(lines[0].indexOf('.'), lines[1].indexOf('.'))
})

test('somebody square is named without a trailing blank column', () => {
  assert.equal(formatBalances([{ person: 'ana', cents: 0 }]), 'ana  is square')
})

test('an empty ledger says so instead of printing nothing', () => {
  assert.match(formatBalances([]), /Nobody has spent anything/)
})

test('transfers read as instructions', () => {
  assert.equal(formatTransfers([{ from: 'bo', to: 'ana', cents: 500 }]), 'bo pays ana 5.00')
})

test('no transfers is good news, and says so', () => {
  assert.match(formatTransfers([]), /Everyone is square/)
})
