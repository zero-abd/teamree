// The command that stands a relay up without a clone of this repository.
//
// What is being defended here is one specific failure, hit by the first person
// to follow the old instructions: `mkdir relay && cd relay && npm install` in a
// directory that has no package.json, answered by npm with ENOENT. There is no
// `npm install` step any more, and the two ways left to be in the wrong place —
// deploying `--here` where there is no project, and writing into a directory
// that holds somebody else's files — are refusals that name the command that
// fixes them. Both are asserted below, against the sentences themselves,
// because a refusal whose wording drifts is a refusal that stops helping.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_DIR,
  describeWrite,
  generatedProject,
  missingTemplatePaths,
  occupiedBy,
  parseArgs,
  projectFault,
  relayEndpointFrom,
  relayPathFrom,
  templatePlan,
  templateRoot,
  wranglerCommand,
  writeProject
} from '../bin/teamree-relay.mjs'

/** The relay package itself: the sources this command carries and copies. */
const RELAY_ROOT = resolve(import.meta.dirname, '..')

const scratches: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamree-relay-deploy-'))
  scratches.push(dir)
  return dir
}

afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true })
})

describe('reading the command line', () => {
  it('takes a directory after deploy, and defaults to none', () => {
    expect(parseArgs(['deploy'])).toMatchObject({ command: 'deploy', dir: null, error: null })
    expect(parseArgs(['deploy', '~/elsewhere'])).toMatchObject({ command: 'deploy', dir: '~/elsewhere' })
  })

  it('reads the flags that change what happens', () => {
    const parsed = parseArgs(['deploy', '--dry-run', '--write-only', '--name', 'our-relay'])
    expect(parsed).toMatchObject({ dryRun: true, writeOnly: true, name: 'our-relay', error: null })
  })

  it('refuses a --name with nothing after it rather than deploying under a flag', () => {
    expect(parseArgs(['deploy', '--name']).error).toBe('--name needs a Worker name after it.')
  })

  it('names the option it does not know, and where the list is', () => {
    expect(parseArgs(['deploy', '--force']).error).toContain('--help')
  })

  it('refuses --here with a directory, because the two mean different places', () => {
    expect(parseArgs(['deploy', '--here', 'somewhere']).error).toContain('takes no directory argument')
  })
})

describe('the project this carries', () => {
  it('is complete in the package it ships in', () => {
    expect(missingTemplatePaths(RELAY_ROOT)).toEqual([])
  })

  it('says what is missing from a package that lost some of it', () => {
    const empty = scratch()
    expect(missingTemplatePaths(empty)).toEqual(['wrangler.jsonc', 'src/core', 'src/workers'])
  })

  it('carries every file the Worker imports, so a deploy cannot fail on a file left behind', () => {
    const copied = new Set(templatePlan(RELAY_ROOT).map((entry) => entry.to))
    const entry = 'src/workers/worker.ts'
    expect(copied.has(entry)).toBe(true)

    // Walk the import graph from the Worker's entry point the way the bundler
    // will, and insist every hop is a file this command copies. A new import
    // that reaches into src/node, or a new directory under src, fails here
    // rather than in somebody's deploy.
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const current = queue.pop() as string
      if (seen.has(current)) continue
      seen.add(current)
      const source = readFileSync(join(RELAY_ROOT, current), 'utf8')
      for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
        // Written as .js in the source and resolved as .ts on disk, which is
        // what NodeNext asks for and what the bundler undoes.
        const target = join(dirname(current), (match[1] as string).replace(/\.js$/, '.ts'))
        expect(copied.has(target), `${current} imports ${target}, which this command does not copy`).toBe(true)
        queue.push(target)
      }
    }
    expect(seen.size).toBeGreaterThan(5)
  })

  it('leaves the container host behind, because this deploys a Worker', () => {
    const copied = templatePlan(RELAY_ROOT).map((entry) => entry.to)
    expect(copied.some((path) => path.startsWith('src/node/'))).toBe(false)
  })
})

describe('writing the project somewhere a person owns', () => {
  it('writes a directory wrangler can deploy from', () => {
    const target = join(scratch(), DEFAULT_DIR)
    const { written, kept } = writeProject(RELAY_ROOT, target)

    expect(kept).toEqual([])
    expect(written).toContain('wrangler.jsonc')
    expect(written).toContain('src/workers/worker.ts')
    expect(written).toContain('package.json')
    expect(projectFault(target)).toBeNull()

    // The entry point wrangler.jsonc names has to be a file that is actually there.
    const main = /"main"\s*:\s*"([^"]+)"/.exec(readFileSync(join(target, 'wrangler.jsonc'), 'utf8'))
    expect(main).not.toBeNull()
    expect(() => readFileSync(join(target, (main as RegExpExecArray)[1] as string), 'utf8')).not.toThrow()
  })

  it('never writes over a second time, so an edited limit survives a redeploy', () => {
    const target = join(scratch(), DEFAULT_DIR)
    writeProject(RELAY_ROOT, target)

    const edited = readFileSync(join(target, 'wrangler.jsonc'), 'utf8').replace('"200"', '"17"')
    writeFileSync(join(target, 'wrangler.jsonc'), edited)

    const second = writeProject(RELAY_ROOT, target)
    expect(second.written).toEqual([])
    expect(second.kept).toContain('wrangler.jsonc')
    expect(readFileSync(join(target, 'wrangler.jsonc'), 'utf8')).toContain('"17"')
  })

  it('adds back a file somebody deleted without touching the rest', () => {
    const target = join(scratch(), DEFAULT_DIR)
    writeProject(RELAY_ROOT, target)
    rmSync(join(target, 'src', 'core', 'clock.ts'))

    const second = writeProject(RELAY_ROOT, target)
    expect(second.written).toEqual(['src/core/clock.ts'])
  })

  it('tells the difference between a first run, a repair and a redeploy', () => {
    expect(describeWrite('~/x', ['a', 'b'], [])).toContain('wrote the Worker project')
    expect(describeWrite('~/x', ['a'], ['b'])).toContain('added 1 missing files')
    expect(describeWrite('~/x', [], ['a', 'b'])).toContain('already there')
  })
})

describe('refusing to be in the wrong place', () => {
  it('treats an empty or absent directory as free', () => {
    const parent = scratch()
    expect(occupiedBy(join(parent, 'not-there'))).toBeNull()
    mkdirSync(join(parent, 'empty'))
    expect(occupiedBy(join(parent, 'empty'))).toBeNull()
  })

  it('names what is in the way rather than writing into a directory that is not ours', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'thesis.txt'), 'mine')
    expect(occupiedBy(dir)).toBe('thesis.txt')
  })

  it('treats a project it wrote before as its own, so a redeploy is not a refusal', () => {
    const target = join(scratch(), DEFAULT_DIR)
    writeProject(RELAY_ROOT, target)
    expect(occupiedBy(target)).toBeNull()
  })

  it('says which half of a relay project is missing', () => {
    const dir = scratch()
    expect(projectFault(dir)).toBe('there is no wrangler.jsonc here')
    writeFileSync(join(dir, 'wrangler.jsonc'), '{}')
    expect(projectFault(dir)).toBe('there is no src/workers/worker.ts here')
  })
})

describe('the address it hands back', () => {
  // Copied from a real `wrangler deploy` run against a real account, because
  // the one thing this function must survive is wrangler's actual output.
  const REAL_OUTPUT = [
    ' ⛅️ wrangler 4.131.1',
    '────────────────────',
    'Total Upload: 35.27 KiB / gzip: 9.88 KiB',
    'Your Worker has access to the following bindings:',
    'env.RENDEZVOUS_PAIR (RelayPair)                    Durable Object',
    'Uploaded teamree-relay (1.33 sec)',
    'Deployed teamree-relay triggers (0.74 sec)',
    '  https://teamree-relay.almahmud-zero.workers.dev',
    'Current Version ID: 687732fe-2fb3-42f9-b130-c064acc83a7a'
  ].join('\n')

  it('turns what wrangler printed into the line that goes in .teamree/relay', () => {
    expect(relayEndpointFrom(REAL_OUTPUT)).toBe('wss://teamree-relay.almahmud-zero.workers.dev/v1/relay')
  })

  it('uses the relay path from the config rather than one of its own', () => {
    expect(relayEndpointFrom(REAL_OUTPUT, '/elsewhere')).toBe('wss://teamree-relay.almahmud-zero.workers.dev/elsewhere')
    expect(relayPathFrom('"vars": { "RELAY_PATH": "/elsewhere" }')).toBe('/elsewhere')
    expect(relayPathFrom('{}')).toBe('/v1/relay')
  })

  it('is not fooled by a documentation link printed on the way', () => {
    const output = `${REAL_OUTPUT}\nRead more at https://developers.cloudflare.com/workers/`
    expect(relayEndpointFrom(output)).toBe('wss://teamree-relay.almahmud-zero.workers.dev/v1/relay')
  })

  it('says nothing rather than guessing when wrangler printed no host', () => {
    expect(relayEndpointFrom('Total Upload: 35.27 KiB')).toBeNull()
  })

  it('speaks wss, never https, because teamree refuses the one the deploy printed', () => {
    expect(relayEndpointFrom(REAL_OUTPUT)?.startsWith('wss://')).toBe(true)
  })
})

describe('the wrangler it runs', () => {
  it('fetches one when the project has none installed', () => {
    expect(wranglerCommand(scratch())).toEqual({ command: 'npx', args: ['--yes', 'wrangler@4'] })
  })

  it('prefers the one the project installed for itself', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.bin', 'wrangler'), '')
    expect(wranglerCommand(dir)).toEqual({ command: join(dir, 'node_modules', '.bin', 'wrangler'), args: [] })
  })
})

describe('what it generates beside the copied sources', () => {
  it('writes a package.json that parses and a README that names the endpoint shape', () => {
    const generated = generatedProject('"RELAY_PATH": "/v1/relay"')
    expect(() => JSON.parse(generated['package.json'] as string)).not.toThrow()
    expect(generated['README.md']).toContain('wss://')
    expect(generated['README.md']).toContain('/v1/relay')
    expect(generated['.gitignore']).toContain('.wrangler/')
  })

  it('carries the relay path a changed config asked for into what it tells you to paste', () => {
    expect(generatedProject('"RELAY_PATH": "/pipe"')['README.md']).toContain('wss://<the host wrangler printed>/pipe')
  })
})

describe('finding the sources it carries', () => {
  it('looks one directory up from itself, which is the relay package in a clone and in the app', () => {
    expect(templateRoot()).toBe(RELAY_ROOT)
  })
})
