// TARGET TEST FOR TASK 3 — repeating entries. Red until the task is done.
//
// Outside `npm test` on purpose: see test/tasks/README.md. Run it with
// `npm run test:task3`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LedgerError, parseLedger } from '../../src/parse.js'
import { balances } from '../../src/settle.js'

const entriesOf = (text) => parseLedger(text).entries

const HUT = '2024-03-02 | cy | 87.00 | ana bo cy | the hut'

test('five fields still parse exactly as they always did', () => {
  assert.deepEqual(entriesOf(`${HUT}\n`), [
    {
      date: '2024-03-02',
      payer: 'cy',
      cents: 8700,
      shared: ['ana', 'bo', 'cy'],
      description: 'the hut',
      line: 1
    }
  ])
})

test('x5 is five entries', () => {
  const entries = entriesOf(`${HUT} | x5\n`)
  assert.equal(entries.length, 5)
  // Identical, and carrying nothing new: the point of expanding at parse time
  // is that nothing downstream of the parser learns what a multiplier is, so an
  // expanded entry is the same object shape a written-out one is.
  assert.deepEqual(
    entries,
    Array.from({ length: 5 }, () => entriesOf(`${HUT}\n`)[0])
  )
})

test('every expanded entry keeps the line somebody wrote', () => {
  const entries = entriesOf(['title: a long week', '', `${HUT} | x3`].join('\n'))
  assert.deepEqual(
    entries.map((entry) => entry.line),
    [3, 3, 3]
  )
})

test('x5 settles the same as the line written out five times', () => {
  const written = Array.from({ length: 5 }, () => HUT).join('\n')
  assert.deepEqual(balances(entriesOf(`${HUT} | x5\n`)), balances(entriesOf(`${written}\n`)))
})

test('a multiplier does not disturb the entries around it', () => {
  const entries = entriesOf(
    ['2024-03-01 | ana | 1.00 | ana | tea', `${HUT} | x2`, '2024-03-04 | bo | 2.00 | bo | bus'].join('\n')
  )
  assert.deepEqual(
    entries.map((entry) => `${entry.description}@${entry.line}`),
    ['tea@1', 'the hut@2', 'the hut@2', 'bus@3']
  )
})

test('x1 is refused, because somebody meant to type something else', () => {
  assert.throws(
    () => parseLedger(`${HUT} | x1\n`),
    (error) => error instanceof LedgerError && error.line === 1
  )
})

for (const multiplier of ['x0', 'x-2', 'x2.5', 'xlots', '5', '']) {
  test(`"${multiplier}" is not a multiplier, and says which line it was on`, () => {
    assert.throws(
      () => parseLedger(['# a trip', `${HUT} | ${multiplier}`].join('\n')),
      (error) => error instanceof LedgerError && error.line === 2
    )
  })
}

test('seven fields are still one field too many', () => {
  assert.throws(() => parseLedger(`${HUT} | x2 | and another thing\n`), LedgerError)
})
