// A stand-in context provider for tests: speaks the NDJSON protocol, or breaks it the way argv[2] says.
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'good'
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let events = 0
let lastEvent = ''
let asked = 0

if (mode === 'noisy') process.stdout.write('Loading the graph…\n')

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.type === 'hello') {
    if (mode !== 'mute') send({ type: 'hello', protocol: mode === 'old' ? 99 : 1, name: 'stub', version: '9.9.9' })
    continue
  }
  if (message.type === 'event') {
    events += 1
    lastEvent = message.event.type
    continue
  }
  asked += 1
  if (mode === 'slow' || (mode === 'slow-after-one' && asked > 1)) continue
  if (mode === 'crash') {
    process.stderr.write('boom\n')
    process.exit(1)
  }
  if (mode === 'garbage') {
    process.stdout.write('not json\n')
    continue
  }
  if (mode === 'long') {
    process.stdout.write(`${'x'.repeat(300_000)}`)
    continue
  }
  if (mode === 'refuses') {
    send({ type: 'error', id: message.id, message: 'no graph yet' })
    continue
  }
  if (message.type === 'context') {
    const related = [
      {
        key: 'pr:7',
        name: 'rate-limit-the-api',
        branch: 'rate-limit-the-api',
        pr: 7,
        goal: 'Rate limit the public API',
        at: 1,
        outcome: 'merged',
        score: 9,
        files: ['src/limiter.ts'],
        terms: ['limit'],
        decisions: ['The limiter keeps its counters in the database']
      }
    ]
    send({ type: 'context', id: message.id, context: { related } })
    continue
  }
  const walker = message.ask.walker
  if (mode === 'bad-answer') {
    send({ type: 'answer', id: message.id, answer: { walker, rows: 'nope' } })
  } else if (walker === 'why_file') {
    const answer = { walker, path: lastEvent || 'none', changes: events, tasks: [], decisions: [], people: [] }
    send({ type: 'answer', id: message.id, answer })
  } else if (walker === 'conflict_risk') {
    send({ type: 'answer', id: message.id, answer: { walker, rows: [], predicted: [] } })
  } else {
    send({ type: 'answer', id: message.id, answer: { walker, tasks: [] } })
  }
}
