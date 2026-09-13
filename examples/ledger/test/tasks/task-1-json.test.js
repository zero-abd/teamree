// TARGET TEST FOR TASK 1 — `--json`. Red until the task is done.
//
// Outside `npm test` on purpose: see test/tasks/README.md. Run it with
// `npm run test:task1`.
//
// What it does not assert, and will not: what `--json` does with a ledger that
// does not parse. That is the "Ask first" decision in TASKS.md task 1, and a
// test here would be this file answering a question that is the team's to
// answer. Ask, get an answer, then write the test for the answer — in this
// file, which is yours for the length of the task.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../../bin/ledger.js', import.meta.url))
const TRIP = fileURLToPath(new URL('../../fixtures/trip.ledger', import.meta.url))

const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })

/** Parses stdout, and fails with the output rather than a bare SyntaxError. */
function jsonFrom(result) {
  assert.equal(result.status, 0, `exited ${result.status}: ${result.stderr}`)
  assert.equal(result.stderr, '', 'nothing but the object may be printed')
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    assert.fail(`stdout is not JSON (${error.message}):\n${result.stdout}`)
  }
}

test('--json prints one object and nothing else', () => {
  const ledger = jsonFrom(run('--json', TRIP))
  assert.equal(ledger.title, 'Weekend in the hills')
  assert.ok(Array.isArray(ledger.balances), 'balances is an array')
  assert.ok(Array.isArray(ledger.transfers), 'transfers is an array')
})

test('the flag works either side of the filename', () => {
  assert.deepEqual(jsonFrom(run('--json', TRIP)), jsonFrom(run(TRIP, '--json')))
})

test('balances are people and integer cents', () => {
  const { balances } = jsonFrom(run('--json', TRIP))
  assert.deepEqual(
    balances.map((row) => row.person),
    ['ana', 'bo', 'cy']
  )
  for (const row of balances) {
    assert.equal(typeof row.cents, 'number')
    assert.ok(Number.isInteger(row.cents), `${row.person} has ${row.cents}, which is not whole cents`)
  }
  // The same numbers the human output prints, still signed the same way.
  assert.deepEqual(balances, [
    { person: 'ana', cents: -1810 },
    { person: 'bo', cents: -1945 },
    { person: 'cy', cents: 3755 }
  ])
})

test('transfers are from, to and integer cents', () => {
  const { transfers } = jsonFrom(run('--json', TRIP))
  assert.deepEqual(transfers, [
    { from: 'bo', to: 'cy', cents: 1945 },
    { from: 'ana', to: 'cy', cents: 1810 }
  ])
})

test('no decimal strings anywhere in the output', () => {
  // The whole reason for cents: a caller that has to parse "18.10" back is a
  // caller handed the floating-point bug this codebase was built to avoid.
  const result = run('--json', TRIP)
  jsonFrom(result)
  assert.doesNotMatch(result.stdout, /"-?\d+\.\d\d"/, 'an amount is being printed as a decimal string')
})

test('without the flag the human output is exactly what it always was', () => {
  const result = run(TRIP)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    [
      'Weekend in the hills',
      '',
      'ana  owes     18.10',
      'bo   owes     19.45',
      'cy   is owed  37.55',
      '',
      'bo pays cy 19.45',
      'ana pays cy 18.10',
      ''
    ].join('\n')
  )
})
