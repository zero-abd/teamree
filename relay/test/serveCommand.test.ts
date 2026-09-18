// The two commands for a relay nobody is deploying: `serve`, which runs one on
// this machine, and `check`, which says whether a relay URL answers.
//
// `serve` is the command with a lie available to it. A relay on somebody's
// laptop works perfectly between two machines on one network and cannot work at
// all between two homes, and the failure looks identical to a broken relay. So
// the sentence that says which of those you have is asserted here against its
// own wording, along with the ordering rule the app's setup panel depends on:
// the last URL printed is the one offered as the team's.
//
// `check` is where the sentences are the whole feature. Every one of them is a
// claim about somebody's network made at the moment they are least able to
// evaluate it, so they are tested as sentences, against a classification that
// takes a status or an errno and nothing else. The dialling itself is proved
// once, against the real relay, at the bottom of this file.

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  FALLBACK_RELAY_PATH,
  SERVE_DEFAULT_DIR,
  SERVE_LIMITATION,
  SERVE_TRUST,
  checkRelay,
  checkTargetFault,
  describeCheck,
  describeServeWrite,
  generatedServeProject,
  lanAddresses,
  missingServeTemplatePaths,
  npmCommand,
  occupiedBy,
  parseArgs,
  relayDefaultPath,
  serveAnnouncement,
  serveProjectFault,
  serveTemplatePlan,
  writeServeProject
} from '../bin/teamree-relay.mjs'

/** The relay package itself: the sources this command carries and copies. */
const RELAY_ROOT = resolve(import.meta.dirname, '..')

const scratches: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamree-relay-serve-'))
  scratches.push(dir)
  return dir
}

afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true })
})

describe('reading the command line for serve and check', () => {
  it('takes a directory after serve, and defaults to none', () => {
    expect(parseArgs(['serve'])).toMatchObject({ command: 'serve', dir: null, error: null })
    expect(parseArgs(['serve', '~/elsewhere'])).toMatchObject({ command: 'serve', dir: '~/elsewhere' })
  })

  it('reads the flags that change where serve listens', () => {
    const parsed = parseArgs(['serve', '--port', '9000', '--host', '127.0.0.1', '--write-only'])
    expect(parsed).toMatchObject({ port: 9000, host: '127.0.0.1', writeOnly: true, error: null })
  })

  it('refuses a port that is not one rather than listening somewhere nobody meant', () => {
    expect(parseArgs(['serve', '--port']).error).toBe('--port needs a port number after it.')
    expect(parseArgs(['serve', '--port', '8O87']).error).toContain('between 0 and 65535')
    expect(parseArgs(['serve', '--port', '70000']).error).toContain('between 0 and 65535')
    expect(parseArgs(['serve', '--host']).error).toBe('--host needs an address after it.')
  })

  it('refuses --here with a directory, because the two mean different places', () => {
    expect(parseArgs(['serve', '--here', 'somewhere']).error).toContain('takes no directory argument')
  })

  it('takes check’s one argument as a URL and not as a directory', () => {
    const parsed = parseArgs(['check', 'wss://relay.example/v1/relay'])
    expect(parsed).toMatchObject({ command: 'check', url: 'wss://relay.example/v1/relay', dir: null, error: null })
  })

  it('refuses a check with nothing to dial, and shows what one looks like', () => {
    expect(parseArgs(['check']).error).toContain('teamree-relay check wss://')
  })

  it('still answers --help for a check with no URL, because that is somebody asking how', () => {
    expect(parseArgs(['check', '--help'])).toMatchObject({ help: true, error: null })
  })
})

describe('the Node relay project this carries', () => {
  it('is complete in the package it ships in', () => {
    expect(missingServeTemplatePaths(RELAY_ROOT)).toEqual([])
  })

  it('says what is missing from a package that lost some of it', () => {
    expect(missingServeTemplatePaths(scratch())).toEqual(['src/core', 'src/node'])
  })

  it('carries every file the relay imports, so a build cannot fail on a file left behind', () => {
    const copied = new Set(serveTemplatePlan(RELAY_ROOT).map((entry) => entry.to))
    const entry = 'src/node/index.ts'
    expect(copied.has(entry)).toBe(true)

    // The same walk the Worker's template gets: follow every relative import
    // from the entry point and insist each hop is a file this command copies.
    // Bare imports are skipped on purpose — `ws` and `node:crypto` are not files
    // in this package, and `ws` is a dependency the generated package.json asks
    // npm for.
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const current = queue.pop() as string
      if (seen.has(current)) continue
      seen.add(current)
      const source = readFileSync(join(RELAY_ROOT, current), 'utf8')
      for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
        // Written as .js in the source and resolved as .ts on disk, which is
        // what NodeNext asks for and what tsc emits back.
        const target = join(dirname(current), (match[1] as string).replace(/\.js$/, '.ts'))
        expect(copied.has(target), `${current} imports ${target}, which this command does not copy`).toBe(true)
        queue.push(target)
      }
    }
    expect(seen.size).toBeGreaterThan(5)
  })

  it('leaves the Worker behind, because nothing here is being deployed', () => {
    const copied = serveTemplatePlan(RELAY_ROOT).map((entry) => entry.to)
    expect(copied.some((path) => path.startsWith('src/workers/'))).toBe(false)
    expect(copied.some((path) => path === 'wrangler.jsonc')).toBe(false)
  })
})

describe('writing the server project somewhere a person owns', () => {
  it('writes a directory npm can build and start from', () => {
    const target = join(scratch(), SERVE_DEFAULT_DIR)
    const { written, kept } = writeServeProject(RELAY_ROOT, target)

    expect(kept).toEqual([])
    expect(written).toContain('src/node/index.ts')
    expect(written).toContain('src/core/config.ts')
    expect(written).toContain('package.json')
    expect(written).toContain('tsconfig.json')
    expect(serveProjectFault(target)).toBeNull()
  })

  it('writes a package.json and a tsconfig that agree with each other', () => {
    const target = join(scratch(), SERVE_DEFAULT_DIR)
    writeServeProject(RELAY_ROOT, target)

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    expect(pkg.type).toBe('module')
    expect(pkg.dependencies.ws).toBe('^8.18.0')
    expect(pkg.devDependencies.typescript).toBeDefined()
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.json')
    expect(pkg.scripts.start).toBe('node dist/node/index.js')

    const tsconfig = JSON.parse(readFileSync(join(target, 'tsconfig.json'), 'utf8'))
    expect(tsconfig.compilerOptions.rootDir).toBe('src')
    expect(tsconfig.compilerOptions.outDir).toBe('dist')
    expect(tsconfig.compilerOptions.module).toBe('NodeNext')
    // The options that change what compiles rather than only what is reported.
    // A project that relaxed either would be building different code from the
    // one this repository typechecks.
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true)
    expect(tsconfig.compilerOptions.exactOptionalPropertyTypes).toBe(true)
    // What `npm start` runs is what `tsc` puts there, which is only true while
    // these two agree.
    expect(`${tsconfig.compilerOptions.outDir}/node/index.js`).toBe(pkg.scripts.start.replace('node ', ''))
  })

  it('never writes over a second time, so an edited limit survives a restart', () => {
    const target = join(scratch(), SERVE_DEFAULT_DIR)
    writeServeProject(RELAY_ROOT, target)

    const edited = readFileSync(join(target, 'package.json'), 'utf8').replace('"0.1.0"', '"9.9.9"')
    writeFileSync(join(target, 'package.json'), edited)

    const second = writeServeProject(RELAY_ROOT, target)
    expect(second.written).toEqual([])
    expect(second.kept).toContain('package.json')
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toContain('"9.9.9"')
  })

  it('adds back a file somebody deleted without touching the rest', () => {
    const target = join(scratch(), SERVE_DEFAULT_DIR)
    writeServeProject(RELAY_ROOT, target)
    rmSync(join(target, 'src', 'core', 'clock.ts'))

    expect(writeServeProject(RELAY_ROOT, target).written).toEqual(['src/core/clock.ts'])
  })

  it('treats a server project it wrote before as its own, and anything else as in the way', () => {
    const target = join(scratch(), SERVE_DEFAULT_DIR)
    writeServeProject(RELAY_ROOT, target)
    expect(occupiedBy(target, serveProjectFault)).toBeNull()

    const other = scratch()
    writeFileSync(join(other, 'thesis.txt'), 'mine')
    expect(occupiedBy(other, serveProjectFault)).toBe('thesis.txt')
  })

  it('says which half of a server project is missing', () => {
    const dir = scratch()
    expect(serveProjectFault(dir)).toBe('there is no package.json here')
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(serveProjectFault(dir)).toBe('there is no src/node/index.ts here')
  })

  it('tells the difference between a first run, a repair and a restart', () => {
    expect(describeServeWrite('~/x', ['a', 'b'], [])).toContain('wrote the relay server project')
    expect(describeServeWrite('~/x', ['a'], ['b'])).toContain('added 1 missing files')
    expect(describeServeWrite('~/x', [], ['a', 'b'])).toContain('already there')
  })

  it('puts the relay’s real path into the README somebody reads later', () => {
    const generated = generatedServeProject('/pipe')
    expect(generated['README.md']).toContain('/pipe')
    expect(generated['.gitignore']).toContain('dist/')
    expect(() => JSON.parse(generated['package.json'] as string)).not.toThrow()
  })
})

describe('the path it says the relay serves', () => {
  // Read out of the file that decides rather than repeated, so the day somebody
  // moves the endpoint there is one place to change. The constant below is only
  // a fallback for a config.ts that cannot be read, and this is what keeps it
  // from silently disagreeing with the real one.
  it('is the one src/core/config.ts actually defaults to', () => {
    expect(relayDefaultPath(RELAY_ROOT)).toBe(FALLBACK_RELAY_PATH)
    expect(readFileSync(join(RELAY_ROOT, 'src', 'core', 'config.ts'), 'utf8')).toContain(
      `path: '${FALLBACK_RELAY_PATH}'`
    )
  })

  it('falls back rather than throwing when there is no config to read', () => {
    expect(relayDefaultPath(scratch())).toBe(FALLBACK_RELAY_PATH)
  })
})

describe('the addresses this machine can be dialled on', () => {
  const fabricated = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.14', family: 'IPv4', internal: false }
    ],
    utun3: [{ address: '10.8.0.2', family: 'IPv4', internal: false }]
  }

  it('takes every IPv4 address somebody else could reach, and no others', () => {
    expect(lanAddresses(fabricated)).toEqual(['192.168.1.14', '10.8.0.2'])
  })

  it('says nothing at all for a machine with no network', () => {
    expect(lanAddresses({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })).toEqual([])
    expect(lanAddresses({})).toEqual([])
    expect(lanAddresses({ en0: undefined })).toEqual([])
  })
})

describe('what serve prints before the relay starts', () => {
  const block = (addresses: string[]): string[] => serveAnnouncement({ port: 8787, path: '/v1/relay', addresses })

  it('says what a relay on this machine cannot do, before any address is offered', () => {
    const lines = block(['192.168.1.14'])
    expect(lines[0]).toBe(SERVE_LIMITATION)
    expect(SERVE_LIMITATION).toContain('two laptops on two different home networks cannot')
    expect(SERVE_LIMITATION).toContain('teamree-relay deploy')
  })

  it('says what being reachable costs, before any address is offered', () => {
    const lines = block(['192.168.1.14'])
    expect(lines[1]).toBe(SERVE_TRUST)
    // Three separate facts, and a banner that dropped any one of them would be
    // either alarming or falsely reassuring.
    expect(SERVE_TRUST).toContain('authenticates nobody')
    expect(SERVE_TRUST).toContain('use up its capacity')
    expect(SERVE_TRUST).toContain('not join your pairing')
    expect(SERVE_TRUST).toContain('not read a byte of what crosses it')
  })

  it('names the loopback and every network address it found', () => {
    const lines = block(['192.168.1.14', '10.8.0.2'])
    expect(lines).toContain('teamree-relay: on this Mac        ws://127.0.0.1:8787/v1/relay')
    expect(lines).toContain('teamree-relay: on this network    ws://192.168.1.14:8787/v1/relay')
    expect(lines).toContain('teamree-relay: on this network    ws://10.8.0.2:8787/v1/relay')
  })

  // The app's setup panel takes the last ws:// or wss:// URL out of this pane
  // and offers it as the one to write into .teamree/relay. That makes the order
  // of these lines a contract rather than a layout choice: anything printed
  // after the team's URL that happens to contain one would be offered instead.
  it('ends on the URL to give your team, which is the one the panel will offer', () => {
    for (const addresses of [['192.168.1.14', '10.8.0.2'], []]) {
      const text = block(addresses).join('\n')
      const urls = [...text.matchAll(/\bwss?:\/\/[^\s"'<>)\]]+/g)].map((match) => match[0])
      const last = urls[urls.length - 1]
      expect(text).toContain(`teamree-relay: the URL to give your team:  ${last}`)
    }
  })

  it('offers the first network address when there is one, and the loopback when there is not', () => {
    expect(block(['192.168.1.14', '10.8.0.2']).at(-1)).toBe(
      'teamree-relay: the URL to give your team:  ws://192.168.1.14:8787/v1/relay'
    )
    expect(block([]).at(-1)).toBe('teamree-relay: the URL to give your team:  ws://127.0.0.1:8787/v1/relay')
  })

  it('carries the port and path it was given into every line', () => {
    const lines = serveAnnouncement({ port: 9000, path: '/pipe', addresses: ['10.0.0.4'] })
    expect(lines.join('\n')).toContain('ws://10.0.0.4:9000/pipe')
    expect(lines.join('\n')).not.toContain(':8787')
  })
})

describe('the URLs check refuses before it dials', () => {
  it('takes a ws or wss URL with a path', () => {
    expect(checkTargetFault('ws://127.0.0.1:8787/v1/relay')).toBeNull()
    expect(checkTargetFault('wss://relay.example/v1/relay')).toBeNull()
  })

  it('names the scheme and the URL to try instead, rather than guessing', () => {
    const fault = checkTargetFault('https://relay.example/v1/relay') as string
    expect(fault).toContain('the scheme is "https", not ws or wss')
    expect(fault).toContain('teamree-relay check wss://relay.example/v1/relay')

    expect(checkTargetFault('http://127.0.0.1:8787/v1/relay')).toContain(
      'teamree-relay check ws://127.0.0.1:8787/v1/relay'
    )
  })

  it('refuses a bare origin, because a relay is served under a path', () => {
    const fault = checkTargetFault('wss://relay.example') as string
    expect(fault).toContain('has no path, and a relay is served under one')
    expect(fault).toContain('teamree-relay check wss://relay.example/v1/relay')
    expect(checkTargetFault('ws://relay.example/')).toContain('teamree-relay check ws://relay.example/v1/relay')
  })

  it('refuses something that is not a URL at all, and shows the shape of one', () => {
    const fault = checkTargetFault('the relay on my laptop') as string
    expect(fault).toContain('is not a URL')
    expect(fault).toContain('wss://your-relay.example/v1/relay')
  })

  // `relay.example:8787` is a URL — WHATWG reads `relay.example:` as its scheme
  // — so it is refused for the scheme rather than for being unparseable, which
  // is the same answer the window gives somebody typing it into the field.
  it('refuses a host:port with no scheme for the scheme it accidentally has', () => {
    expect(checkTargetFault('relay.example:8787')).toContain('not ws or wss')
  })
})

describe('what check says happened', () => {
  const url = 'ws://127.0.0.1:8787/v1/relay'

  it('says a relay is there, and exactly how much that proves', () => {
    const verdict = describeCheck(url, { status: 101 })
    expect(verdict.ok).toBe(true)
    expect(verdict.headline).toBe(
      'teamree-relay: ws://127.0.0.1:8787/v1/relay answered the WebSocket upgrade. A relay is listening there.'
    )
    // The one way this command misleads somebody: a relay that answers here and
    // is unreachable from the machine that has to meet it.
    expect(verdict.advice).toContain('from this machine')
    expect(verdict.advice).toContain('does not prove a teammate on another network can reach it')
  })

  it('tells a wrong path apart from a refusal apart from a full relay', () => {
    const missing = describeCheck(url, { status: 404 })
    expect(missing.ok).toBe(false)
    expect(missing.headline).toBe(
      'teamree-relay: ws://127.0.0.1:8787/v1/relay answered HTTP 404, which is not an upgrade.'
    )
    expect(missing.advice).toContain('serves no relay at that path')
    expect(missing.advice).toContain('/v1/relay')

    expect(describeCheck(url, { status: 403 }).advice).toContain('in front of the relay is refusing')

    const busy = describeCheck(url, { status: 503 })
    expect(busy.headline).toContain('answered HTTP 503')
    expect(busy.advice).toContain('at capacity or shutting down')
    expect(busy.advice).toContain('try it again')
  })

  it('names the relay’s own default path from the config rather than one of its own', () => {
    expect(describeCheck(url, { status: 404 }, '/pipe').advice).toContain('/pipe')
  })

  it('tells nothing listening apart from nothing resolving apart from nothing answering', () => {
    const refused = describeCheck(url, { code: 'ECONNREFUSED' })
    expect(refused.ok).toBe(false)
    expect(refused.headline).toBe('teamree-relay: nothing answered at ws://127.0.0.1:8787/v1/relay (ECONNREFUSED).')
    expect(refused.advice).toBe('teamree-relay: nothing is listening on that port on that host.')

    expect(describeCheck(url, { code: 'ENOTFOUND' }).advice).toBe(
      'teamree-relay: that host name does not resolve from this machine.'
    )
    for (const code of ['ETIMEDOUT', 'EHOSTUNREACH']) {
      expect(describeCheck(url, { code }).advice).toContain('a firewall or the wrong network looks like')
    }
  })

  it('still says something useful about a code nobody anticipated', () => {
    const odd = describeCheck(url, { code: 'ERR_SSL_WRONG_VERSION_NUMBER' })
    expect(odd.ok).toBe(false)
    expect(odd.headline).toContain('ERR_SSL_WRONG_VERSION_NUMBER')
    expect(odd.advice).toContain('failed before any relay could answer')
  })
})

describe('the npm it runs', () => {
  it('spells npm the way the platform can spawn it', () => {
    expect(npmCommand()).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm')
  })
})

// ------------------------------------------------ against the real thing --

// Everything above is sentences. This is the one place the handshake itself is
// proved, and it is proved against the relay this package builds rather than
// against a server written here — a hand-rolled upgrade that only ever answered
// a hand-rolled request would be two halves of the same guess.
//
// It needs the relay built, which is a separate step with its own dependencies
// and its own dist/. When that is absent this says so loudly and skips, because
// a missing build is not a broken command — but a skip that says nothing is how
// a suite quietly stops testing the thing it was written for.
const RELAY_ENTRY = join(RELAY_ROOT, 'dist', 'node', 'index.js')
const RELAY_BUILT = existsSync(RELAY_ENTRY)

if (!RELAY_BUILT) {
  console.warn(
    `[relay] skipping the real-dial tests: ${RELAY_ENTRY} is not there.\n` +
      '[relay] build it with:  cd relay && npm install && npm run build'
  )
}

describe.skipIf(!RELAY_BUILT)('dialling a relay that is really there', () => {
  // stdin is ignored and both outputs are pipes, which is the shape the port is
  // read out of below.
  let child: ChildProcessByStdio<null, Readable, Readable>
  let port: number

  beforeAll(async () => {
    child = spawn(process.execPath, [RELAY_ENTRY], {
      cwd: RELAY_ROOT,
      env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // The port the OS picked, learned from the line the relay logs rather than
    // from a guess: a hard-coded port is how a suite starts failing the moment
    // anything else on the machine wants one.
    port = await new Promise<number>((done, fail) => {
      let buffer = ''
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line) as { event?: string; port?: number }
            if (entry.event === 'relay.listening' && typeof entry.port === 'number') {
              child.stdout.off('data', onData)
              done(entry.port)
              return
            }
          } catch {
            // Not a whole JSON line yet; keep reading.
          }
        }
      }
      child.stdout.on('data', onData)
      child.once('exit', (code) => fail(new Error(`the relay exited with ${code} before it listened`)))
    })
  })

  afterAll(async () => {
    if (child === undefined || child.exitCode !== null) return
    await new Promise<void>((done) => {
      child.once('exit', () => done())
      child.kill('SIGTERM')
    })
  })

  it('reads a real 101 off the real relay, and calls it a pass', async () => {
    const url = `ws://127.0.0.1:${port}/v1/relay`
    const outcome = await checkRelay(url)
    expect(outcome).toEqual({ status: 101 })
    expect(describeCheck(url, outcome).ok).toBe(true)
  })

  it('reads the real 404 the relay gives a path it does not serve', async () => {
    const url = `ws://127.0.0.1:${port}/not-the-relay`
    const outcome = await checkRelay(url)
    expect(outcome).toEqual({ status: 404 })
    expect(describeCheck(url, outcome).advice).toContain('serves no relay at that path')
  })

  it('reports a port nothing is listening on as a refusal rather than a hang', async () => {
    // A port the OS handed out and then took back, which is the closest thing
    // to a guaranteed-closed port there is.
    const closed = await new Promise<number>((done) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const chosen = typeof address === 'object' && address !== null ? address.port : 0
        server.close(() => done(chosen))
      })
    })

    const url = `ws://127.0.0.1:${closed}/v1/relay`
    const outcome = await checkRelay(url, { timeoutMs: 5_000 })
    expect(outcome).toEqual({ code: 'ECONNREFUSED' })
    const verdict = describeCheck(url, outcome)
    expect(verdict.ok).toBe(false)
    expect(verdict.advice).toBe('teamree-relay: nothing is listening on that port on that host.')
  })
})
