// The CLI is tested by running it, because exit codes are the part of it that
// another program depends on and the part a unit test cannot see.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/ledger.js', import.meta.url))
const TRIP = fileURLToPath(new URL('../fixtures/trip.ledger', import.meta.url))

const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })

test('settles the example ledger and exits 0', () => {
  const result = run(TRIP)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Weekend in the hills$/m)
  assert.match(result.stdout, /is owed|owes/)
  assert.match(result.stdout, /pays/)
})

test('with no arguments it prints usage and exits 2', () => {
  const result = run()
  assert.equal(result.status, 2)
  assert.match(result.stdout, /usage: ledger/)
})

test('--help is a request, not a mistake, so it exits 0', () => {
  const result = run('--help')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /usage: ledger/)
})

test('a missing file is reported on stderr and exits 1', () => {
  const result = run('nowhere.ledger')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot read nowhere\.ledger/)
  assert.equal(result.stdout, '')
})

test('a bad line names the file and the line, and prints no settlement', () => {
  const bad = fileURLToPath(new URL('../fixtures/broken.ledger', import.meta.url))
  const result = run(bad)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /broken\.ledger: line 4:/)
  assert.equal(result.stdout, '')
})
