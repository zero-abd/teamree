#!/usr/bin/env node
// A scripted stand-in for a coding agent, linked as `claude` or `codex` so a test or a
// screenshot never runs the real one. It reads prompts from its tty (a paste, then Return),
// follows the script in $TEAMREE_STAND_IN_SCRIPT, and talks to teamree through the real CLI
// ($TEAMREE_STAND_IN_CLI, else $TEAMREE_CLI), reporting Stop and UserPromptSubmit as hooks would.
//
// Script lines, `#` for comments:
//   ask parent "Which store?" options redis,postgres     each step starts when the last one ends
//   done "Added limiter. Tests pass. Nothing left." [failed]
//   child tests ./child.script "Write the limiter tests"
//   supervise 2                        wait on children: answer their asks, until 2 are done
//   after 2s say "…"                  a step can wait first; the steps and the task are one turn
//   exit                               leave once this turn ends
//   on "[teamree] ask" reply "postgres"
//   actions also: note <to> "<text>", say "<text>", write <file> "<text>", screen <file>, work 2s

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

const scriptPath = process.env.TEAMREE_STAND_IN_SCRIPT
const cli = process.env.TEAMREE_STAND_IN_CLI || process.env.TEAMREE_CLI
const pane = process.env.TEAMREE_TERMINAL_ID
const self = process.argv[1]

// Each line starts by clearing the idle `> ` it may be drawn over.
const out = (text = '') => process.stdout.write(`\r\x1b[K${String(text).replace(/\r?\n/g, '\r\n')}\r\n`)

/** Words, with "double quoted" runs kept whole. */
function words(line) {
  const found = []
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    found.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2])
  }
  return found
}

function readScript() {
  if (!scriptPath) return { timeline: [], rules: [] }
  const timeline = []
  const rules = []
  for (const raw of readFileSync(scriptPath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [head, ...rest] = words(line)
    if (head === 'after') {
      const seconds = Number.parseFloat(rest[0] ?? '0')
      timeline.push({ delayMs: Math.round(seconds * 1000), action: rest.slice(1) })
    } else if (head === 'on') {
      rules.push({ match: rest[0] ?? '', action: rest.slice(1) })
    } else {
      timeline.push({ delayMs: 0, action: [head, ...rest] })
    }
  }
  return { timeline, rules }
}

function teamree(args, input) {
  if (!cli) return { status: 3, stdout: '', stderr: 'no teamree CLI' }
  const command = cli.endsWith('.js') || cli.endsWith('.mjs') ? [process.execPath, cli] : [cli]
  const run = spawnSync(command[0], [...command.slice(1), ...args], {
    encoding: 'utf8',
    input: input ?? '',
    env: process.env
  })
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
}

function hook(event) {
  if (pane) teamree(['agent', 'event', '--terminal', pane, '--event', event], '{}')
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** One tool call as an agent draws it, with teamree's answer under it. */
function called(args, result) {
  const shown = args.map((word, at) => (args[at - 1] === '--agent' ? 'claude' : word))
  out(`⏺ teamree ${shown.map((word) => (/\s/.test(word) ? `"${word}"` : word)).join(' ')}`)
  const said = (result.status === 0 ? result.stdout : result.stderr || result.stdout).trim()
  for (const line of said.split('\n').filter(Boolean).slice(0, 3)) out(`  ⎿ ${line.slice(0, 100)}`)
}

async function act(action, trigger = '') {
  const [verb, ...rest] = action
  const flagged = (name) => {
    const at = rest.indexOf(name)
    return at === -1 ? undefined : rest[at + 1]
  }
  switch (verb) {
    case 'say':
      out(`⏺ ${rest.join(' ')}`)
      return
    case 'write':
      writeFileSync(rest[0] ?? 'stand-in.txt', `${rest[1] ?? ''}\n`)
      out(`⏺ Wrote ${rest[0]}`)
      return
    case 'screen':
      out(readFileSync(fromScript(rest[0] ?? ''), 'utf8'))
      return
    case 'work': {
      const until = Date.now() + Number.parseFloat(rest[0] ?? '1') * 1000
      while (Date.now() < until) {
        out('✻ Working…')
        await sleep(200)
      }
      return
    }
    case 'ask': {
      const options = flagged('options')
      const args = [
        'msg',
        'ask',
        rest[1] ?? '',
        '--to',
        rest[0] ?? 'parent',
        ...(options ? ['--options', options] : [])
      ]
      called(args, teamree(args))
      return
    }
    case 'reply': {
      const id = /ask #(\d+)/.exec(trigger)?.[1]
      if (id === undefined) return out('⏺ nothing to reply to')
      const args = ['msg', 'reply', id, rest[0] ?? '']
      called(args, teamree(args))
      return
    }
    case 'done': {
      const args = ['msg', 'done', rest[0] ?? '', ...(rest.includes('failed') ? ['--failed'] : [])]
      called(args, teamree(args))
      return
    }
    case 'note': {
      const args = ['msg', 'note', rest[1] ?? '', '--to', rest[0] ?? 'parent']
      called(args, teamree(args))
      return
    }
    case 'child': {
      const [name, script, prompt] = rest
      const command = `TEAMREE_STAND_IN_SCRIPT=${fromScript(script ?? '')} ${self}`
      const args = [
        'worktree',
        'create',
        '--parent',
        'here',
        '--name',
        name ?? 'child',
        '--agent',
        command,
        '--prompt',
        prompt ?? name ?? ''
      ]
      called(args, teamree(args))
      return
    }
    case 'supervise':
      return supervise(Number.parseInt(rest[0] ?? '1', 10))
    case 'exit':
      leaving = true
      return
    default:
      out(`⏺ unknown action: ${verb}`)
  }
}

function fromScript(path) {
  return isAbsolute(path) || !scriptPath ? path : resolve(dirname(scriptPath), path)
}

/** The supervisor loop: `msg wait` for children, answering asks by the rules, until enough are done. */
async function supervise(count) {
  let done = 0
  while (done < count) {
    const args = ['msg', 'wait', '--kind', 'done,ask', '--from', 'children', '--json']
    const result = teamree(args)
    if (result.status !== 0) {
      called(args, result)
      return
    }
    for (const message of JSON.parse(result.stdout).data) {
      if (message.kind === 'done') {
        done += 1
        out(`⏺ #${message.id} done (${message.outcome}): ${message.text}`)
      } else {
        const text = `[teamree] ask #${message.id}: ${message.text}`
        out(`⏺ ${text}`)
        await follow(text)
      }
    }
  }
  out(`⏺ all ${count} children done`)
}

async function follow(text) {
  for (const rule of rules) if (text.includes(rule.match)) await act(rule.action, text)
}

// One job at a time, reported as a turn: UserPromptSubmit before, Stop once nothing is left.
let queue = Promise.resolve()
let pending = 0
/** Set by `exit`: the process ends with the turn it was set in. */
let leaving = false
function job(run) {
  if (pending === 0) hook('UserPromptSubmit')
  pending += 1
  queue = queue
    .then(run)
    .catch((error) => out(`⏺ ${error?.message ?? error}`))
    .finally(() => {
      pending -= 1
      if (pending === 0) {
        hook('Stop')
        if (leaving) process.exit(0)
        process.stdout.write('> ')
      }
    })
}

/** A prompt as the agent shows it, or null for an empty one. */
function shown(prompt) {
  const text = prompt.replace(/\x1b\[20[01]~/g, '').trim()
  if (text === '') return null
  out(`> ${text}`)
  return text
}

function received(prompt) {
  const text = shown(prompt)
  if (text !== null) job(() => follow(text))
}

const { timeline, rules } = readScript()

out('✻ stand-in agent')
out()
const firstPrompt = process.argv
  .slice(2)
  .filter((arg, at, all) => {
    if (arg.startsWith('-')) return false
    const before = all[at - 1]
    return before === undefined || !['--settings', '--session-id', '--resume', '-r'].includes(before)
  })
  .at(-1)
// The task and the script's steps are one turn, as a real agent's first turn is: no Stop between
// steps, so nothing is pasted into a prompt this process is not reading.
if (firstPrompt || timeline.length > 0) {
  job(async () => {
    const task = firstPrompt === undefined ? null : shown(firstPrompt)
    if (task !== null) await follow(task)
    for (const step of timeline) {
      if (step.delayMs > 0) await sleep(step.delayMs)
      await act(step.action)
    }
  })
} else {
  process.stdout.write('> ')
}

// Raw, so a paste arrives whole with its markers and Return is ours to read.
let typed = ''
let pasting = false
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  let rest = chunk
  while (rest.length > 0) {
    if (rest.startsWith('\x1b[200~')) {
      pasting = true
      rest = rest.slice(6)
    } else if (rest.startsWith('\x1b[201~')) {
      pasting = false
      rest = rest.slice(6)
    } else {
      const char = rest[0]
      rest = rest.slice(1)
      if (char === '\x03' || char === '\x04') process.exit(0)
      if (!pasting && (char === '\r' || char === '\n')) {
        received(typed)
        typed = ''
      } else {
        typed += char
      }
    }
  }
})
process.stdin.on('end', () => process.exit(0))
