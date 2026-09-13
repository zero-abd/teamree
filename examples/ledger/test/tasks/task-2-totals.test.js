// TARGET TEST FOR TASK 2 — per-person totals. Red until the task is done.
//
// Outside `npm test` on purpose: see test/tasks/README.md. Run it with
// `npm run test:task2`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLedger } from '../../src/parse.js'
import * as settle from '../../src/settle.js'

const entriesOf = (text) => parseLedger(text).entries

/**
 * Namespace import rather than `import { totalsByPerson }`: a named import that
 * does not exist is a link-time SyntaxError over the whole file, which says
 * nothing about which task it belongs to. This says it.
 */
function totalsByPerson(entries) {
  assert.equal(
    typeof settle.totalsByPerson,
    'function',
    'src/settle.js does not export totalsByPerson yet — that is this task'
  )
  return settle.totalsByPerson(entries)
}

test('what one person put in, and what their share of it was', () => {
  assert.deepEqual(totalsByPerson(entriesOf('2024-03-01 | ana | 10.00 | ana bo | tea\n')), [
    { person: 'ana', paid: 1000, owed: 500 },
    { person: 'bo', paid: 0, owed: 500 }
  ])
})

test('somebody who never paid still appears, with paid 0', () => {
  const totals = totalsByPerson(entriesOf('2024-03-01 | ana | 9.00 | bo cy | tea\n'))
  assert.deepEqual(totals, [
    { person: 'ana', paid: 900, owed: 0 },
    { person: 'bo', paid: 0, owed: 450 },
    { person: 'cy', paid: 0, owed: 450 }
  ])
})

test('a payer who did not share it owes nothing of it', () => {
  const [ana] = totalsByPerson(entriesOf('2024-03-01 | ana | 10.00 | bo | tea\n'))
  assert.deepEqual(ana, { person: 'ana', paid: 1000, owed: 0 })
})

test('totals come back sorted by name', () => {
  const totals = totalsByPerson(entriesOf('2024-03-01 | cy | 3.00 | cy bo ana | tea\n'))
  assert.deepEqual(
    totals.map((row) => row.person),
    ['ana', 'bo', 'cy']
  )
})

test('paid minus owed is the balance, odd cents and all', () => {
  // The test worth writing and the trap worth falling into. 10.00 across three
  // people is 334 + 333 + 333, and `balances` hands the extra cent to the first
  // participant *in the entry's own order*. Any other way of dividing it —
  // rounding, or sorting the names first — makes these two numbers disagree by
  // a penny, which is the bug this asserts against.
  const text = [
    '2024-03-01 | cy  | 10.00 | ana bo cy | tea',
    '2024-03-02 | ana | 42.60 | ana bo cy | groceries',
    '2024-03-03 | bo  |  0.05 | cy ana    | a stamp'
  ].join('\n')
  const entries = entriesOf(text)

  const balances = new Map(settle.balances(entries).map((row) => [row.person, row.cents]))
  for (const row of totalsByPerson(entries)) {
    assert.equal(row.paid - row.owed, balances.get(row.person), `${row.person} disagrees with their balance`)
  }
})

test('everything paid was owed by somebody', () => {
  const entries = entriesOf(
    ['2024-03-01 | ana | 42.60 | ana bo cy | groceries', '2024-03-02 | cy | 87.01 | ana bo cy | the hut'].join('\n')
  )
  const totals = totalsByPerson(entries)
  const sum = (key) => totals.reduce((running, row) => running + row[key], 0)
  assert.equal(sum('paid'), 12961)
  assert.equal(sum('owed'), sum('paid'))
})
