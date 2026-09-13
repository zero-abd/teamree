// DIAGNOSTIC. Not a test: it asserts nothing and prints what the platform
// actually did, so a Mac can be read as an instrument.
//
// Why it exists. `teamreeWatcher.test.ts` fails on macOS and never on Linux,
// always with `nothing was reported`, and three fixes in a row were guesses at
// what macOS puts in an event's `filename` — each made on a Linux box, each
// disproved by the next run on a Mac. This asks the platform instead of
// guessing at it.
//
// It is skipped unless `TEAMREE_MAC_PROBE=1`, because it spends a minute in
// sleeps and belongs to nobody's ordinary suite. A GitHub Actions workflow used
// to set it on a macOS runner; that has been removed along with the rest of
// them, so it is now a command somebody types on a Mac:
//
//   TEAMREE_MAC_PROBE=1 npx vitest run src/main/teamwork/macWatchProbe.test.ts
//
// Read the log for lines beginning `[probe]`:
//
//   `0`  does a bare `fs.watch` on a directory fire at all — under `os.tmpdir()`
//        and under its resolved path, with `persistent` both ways. A `NEVER
//        FIRED` line here says the primitive is the problem and nothing in
//        `teamreeWatcher.ts` can be blamed for it.
//   `A`  the failing test's exact sequence, watched for twenty seconds rather
//        than five. `events=0` means the event never came; a first event past
//        5000ms means it came too late for the test and the watch is alive.
//   `B`  the same with a second's pause after attaching. If `A` is silent and
//        `B` is not, `fs.watch` returns before the watch is listening.
//   `C`  how long after `fs.watch` returns the watch starts delivering, poked
//        every 25ms until it speaks. This is the number the fix is sized
//        against.
//   `D`  what a non-recursive watch on the checkout root is told about a write
//        three levels down, and about `.teamree` being removed.
//
// Delete this file once the answer is in the watcher.

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'vitest'

type Seen = { at: number; target: string; eventType: string; filename: string | null }

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function say(line: string): void {
  console.log(`[probe] ${line}`)
}

async function checkout(base?: string): Promise<string> {
  const root = await mkdtemp(join(base ?? tmpdir(), 'probe-'))
  roots.push(root)
  return root
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Rig = { seen: Seen[]; close: () => void; start: number; attachMs: Record<string, number | string> }

function attachAll(targets: string[], persistent: boolean): Rig {
  const seen: Seen[] = []
  const handles: FSWatcher[] = []
  const attachMs: Record<string, number | string> = {}
  const start = performance.now()
  for (const target of targets) {
    const before = performance.now()
    try {
      const watcher = fsWatch(target, { persistent }, (eventType, filename) => {
        seen.push({
          at: performance.now() - start,
          target,
          eventType,
          filename: typeof filename === 'string' ? filename : null
        })
      })
      watcher.on('error', (error) => {
        seen.push({ at: performance.now() - start, target, eventType: `ERROR:${String(error)}`, filename: null })
      })
      handles.push(watcher)
      attachMs[short(target)] = Math.round((performance.now() - before) * 100) / 100
    } catch (error) {
      attachMs[short(target)] = `THREW ${String(error)}`
    }
  }
  return {
    seen,
    start,
    attachMs,
    close: () => {
      for (const handle of handles) {
        try {
          handle.close()
        } catch {
          // closing a watch whose directory has gone is routine
        }
      }
    }
  }
}

function short(path: string): string {
  return path.split('/').slice(-2).join('/')
}

async function writeMember(root: string, handle: string): Promise<void> {
  await mkdir(join(root, '.teamree', 'members'), { recursive: true })
  await writeFile(join(root, '.teamree', 'members', `${handle}.pub`), `handle: ${handle}\n`, 'utf8')
}

function firstPer(rig: Rig): string {
  const byTarget = new Map<string, Seen>()
  for (const event of rig.seen) if (!byTarget.has(event.target)) byTarget.set(event.target, event)
  return [...byTarget].map(([target, event]) => `${short(target)}@${Math.round(event.at)}ms`).join(' ')
}

// Off by default: this is an instrument, not part of anybody's suite.
const probing = process.env.TEAMREE_MAC_PROBE === '1'

describe('macOS watch probe', () => {
  it.skipIf(!probing)('says where it is running', async () => {
    say(`platform=${process.platform} arch=${process.arch} node=${process.version}`)
    say(
      `cpus=${cpus().length} load=${loadavg()
        .map((n) => n.toFixed(2))
        .join(',')}`
    )
    say(`tmpdir=${tmpdir()} realpath=${await realpath(tmpdir())}`)
  })

  // The blunt question first: does fs.watch on a directory fire at all here,
  // under each of the four combinations that could explain silence?
  it.skipIf(!probing)(
    'probe 0: does a bare fs.watch on one directory ever fire',
    async () => {
      const resolvedTmp = await realpath(tmpdir())
      for (const persistent of [false, true]) {
        for (const [label, base] of [
          ['tmpdir', tmpdir()],
          ['realpath', resolvedTmp]
        ] as const) {
          const dir = await checkout(base)
          const rig = attachAll([dir], persistent)
          await writeFile(join(dir, 'hello.txt'), 'hi\n', 'utf8')
          const deadline = performance.now() + 10_000
          while (rig.seen.length === 0 && performance.now() < deadline) await sleep(20)
          const first = rig.seen[0]
          say(
            `0 base=${label} persistent=${persistent} attach=${JSON.stringify(rig.attachMs)} ` +
              `events=${rig.seen.length} ` +
              (first
                ? `first=${Math.round(first.at)}ms ${first.eventType} ${JSON.stringify(first.filename)}`
                : 'NEVER FIRED')
          )
          rig.close()
        }
      }
    },
    180_000
  )

  // The failing test's exact shape: attach, then write with nothing in between.
  it.skipIf(!probing)(
    'probe A: attach then write immediately, watched for 20s',
    async () => {
      for (let trial = 1; trial <= 5; trial += 1) {
        const root = await checkout()
        await writeMember(root, 'ana')
        const targets = [root, join(root, '.teamree'), join(root, '.teamree', 'members')]
        const rig = attachAll(targets, false)
        await writeMember(root, 'bo')
        const deadline = performance.now() + 20_000
        while (rig.seen.length === 0 && performance.now() < deadline) await sleep(20)
        say(`A${trial} attach=${JSON.stringify(rig.attachMs)} events=${rig.seen.length} first=[${firstPer(rig)}]`)
        for (const event of rig.seen.slice(0, 10)) {
          say(
            `A${trial}   ${Math.round(event.at)}ms ${event.eventType} ${JSON.stringify(event.filename)} on ${short(event.target)}`
          )
        }
        rig.close()
      }
    },
    300_000
  )

  // Same, with a pause between attaching and writing.
  it.skipIf(!probing)(
    'probe B: attach, wait 1s, then write',
    async () => {
      for (let trial = 1; trial <= 5; trial += 1) {
        const root = await checkout()
        await writeMember(root, 'ana')
        const targets = [root, join(root, '.teamree'), join(root, '.teamree', 'members')]
        const rig = attachAll(targets, false)
        await sleep(1_000)
        await writeMember(root, 'bo')
        const deadline = performance.now() + 20_000
        while (rig.seen.length === 0 && performance.now() < deadline) await sleep(20)
        say(`B${trial} events=${rig.seen.length} first=[${firstPer(rig)}]`)
        rig.close()
      }
    },
    300_000
  )

  // How long after fs.watch() returns does the watch actually deliver?
  it.skipIf(!probing)(
    'probe C: arming latency, poked every 25ms until it speaks',
    async () => {
      for (const persistent of [false, true]) {
        const armed: number[] = []
        for (let trial = 1; trial <= 8; trial += 1) {
          const root = await checkout()
          await writeMember(root, 'ana')
          const members = join(root, '.teamree', 'members')
          const rig = attachAll([members], persistent)
          let poke = 0
          const deadline = performance.now() + 15_000
          while (rig.seen.length === 0 && performance.now() < deadline) {
            poke += 1
            await writeFile(join(members, `poke-${poke}.pub`), `handle: p${poke}\n`, 'utf8')
            await sleep(25)
          }
          const first = rig.seen[0]
          armed.push(first === undefined ? -1 : Math.round(first.at))
          rig.close()
        }
        say(`C persistent=${persistent} ms-to-first-event=[${armed.join(', ')}] (-1 means never)`)
      }
    },
    400_000
  )

  // Does a non-recursive watch on the checkout root hear anything nested?
  it.skipIf(!probing)(
    'probe D: what the checkout-root watch is told',
    async () => {
      const root = await checkout()
      await writeMember(root, 'ana')
      const rig = attachAll([root], false)
      await sleep(1_500)
      await writeMember(root, 'bo')
      await sleep(2_000)
      say(`D after nested write: root-events=${rig.seen.length}`)
      for (const event of rig.seen)
        say(`D   ${Math.round(event.at)}ms ${event.eventType} ${JSON.stringify(event.filename)}`)
      const before = rig.seen.length
      await rm(join(root, '.teamree'), { recursive: true, force: true })
      await sleep(2_000)
      say(`D after rm .teamree: root-events=${rig.seen.length} (was ${before})`)
      for (const event of rig.seen.slice(before)) {
        say(`D   ${Math.round(event.at)}ms ${event.eventType} ${JSON.stringify(event.filename)}`)
      }
      rig.close()
    },
    180_000
  )
})
