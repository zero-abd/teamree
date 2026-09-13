import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLedger } from '../src/parse.js'
import { balances, settle, splitShares, totalCents } from '../src/settle.js'

const entriesOf = (text) => parseLedger(text).entries

test('an exact split gives everyone the same share', () => {
  assert.deepEqual(splitShares(900, 3), [300, 300, 300])
})

test('an inexact split puts the odd cents at the front and still sums', () => {
  const shares = splitShares(1000, 3)
  assert.deepEqual(shares, [334, 333, 333])
  assert.equal(
    shares.reduce((sum, share) => sum + share, 0),
    1000
  )
})

test('one person paying for themselves nets to zero', () => {
  const rows = balances(entriesOf('2024-03-01 | ana | 10.00 | ana | tea\n'))
  assert.deepEqual(rows, [{ person: 'ana', cents: 0 }])
})

test('a payer who shared the cost only carries the others', () => {
  const rows = balances(entriesOf('2024-03-01 | ana | 10.00 | ana bo | tea\n'))
  assert.deepEqual(rows, [
    { person: 'ana', cents: 500 },
    { person: 'bo', cents: -500 }
  ])
})

test('a payer who did not share it is owed the whole amount', () => {
  const rows = balances(entriesOf('2024-03-01 | ana | 10.00 | bo cy | tea\n'))
  assert.deepEqual(rows, [
    { person: 'ana', cents: 1000 },
    { person: 'bo', cents: -500 },
    { person: 'cy', cents: -500 }
  ])
})

test('balances always sum to zero, odd cents and all', () => {
  const rows = balances(entriesOf('2024-03-01 | ana | 10.00 | ana bo cy | tea\n'))
  assert.equal(totalCents(rows), 0)
})

test('balances come back sorted by name', () => {
  const rows = balances(entriesOf('2024-03-01 | cy | 3.00 | ana bo cy | tea\n'))
  assert.deepEqual(
    rows.map((row) => row.person),
    ['ana', 'bo', 'cy']
  )
})

test('nobody owing anybody needs no transfers', () => {
  assert.deepEqual(settle(balances(entriesOf('2024-03-01 | ana | 10.00 | ana | tea\n'))), [])
})

test('one debt becomes one payment', () => {
  const transfers = settle(balances(entriesOf('2024-03-01 | ana | 10.00 | ana bo | tea\n')))
  assert.deepEqual(transfers, [{ from: 'bo', to: 'ana', cents: 500 }])
})

test('transfers settle everyone exactly', () => {
  const rows = balances(
    entriesOf(['2024-03-01 | ana | 42.60 | ana bo cy | food', '2024-03-02 | cy | 87.00 | ana bo cy | hut'].join('\n'))
  )
  const net = new Map(rows.map((row) => [row.person, row.cents]))
  for (const transfer of settle(rows)) {
    net.set(transfer.from, net.get(transfer.from) + transfer.cents)
    net.set(transfer.to, net.get(transfer.to) - transfer.cents)
  }
  assert.deepEqual([...net.values()], [0, 0, 0])
})

test('never needs more transfers than there are people, minus one', () => {
  const rows = balances(
    entriesOf(
      [
        '2024-03-01 | ana | 40.00 | ana bo cy di | food',
        '2024-03-02 | bo  | 10.00 | ana bo cy di | tea',
        '2024-03-03 | cy  |  7.31 | ana bo cy di | bus'
      ].join('\n')
    )
  )
  assert.ok(settle(rows).length <= rows.length - 1)
})

test('the same ledger settles the same way twice', () => {
  const text = ['2024-03-01 | ana | 9.99 | ana bo cy | food', '2024-03-02 | bo | 5.00 | ana bo cy | tea'].join('\n')
  assert.deepEqual(settle(balances(entriesOf(text))), settle(balances(entriesOf(text))))
})
