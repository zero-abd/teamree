// `teamree team accept`, driven end to end against a real socket, a real
// argument parser, a stub runtime and — for the one test that clones — a real
// git repository on a real disk.
//
// It has a file of its own rather than a block in team.test.ts because it is the
// only command here that writes to the machine it runs on. The world it acts on
// is therefore built per test rather than frozen at the top: which projects
// exist, what their origins are, whether the relay file is already there and
// what the push did are the four things every interesting case varies.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExitCode } from './exit.js'
import { formatInvitation } from './invitation.js'
import type { Streams } from './output.js'
import { runCli } from './run.js'
import { StubError, startStubRuntime, type StubHandler, type StubRuntime } from './stub-runtime.js'

const NOW = 1_700_000_000_000
const ORIGIN = 'https://github.com/acme/api.git'
const RELAY_URL = 'wss://relay.example/v1/relay'

const LINK = formatInvitation({ origin: ORIGIN, relay: RELAY_URL, project: 'api', from: 'ana' })

/**
 * What the runtime on the other end believes, so a test can change one fact
 * about the machine and leave the other twenty alone.
 */
type World = {
  /** Projects already known, with the origin each one's status reports. */
  projects: Array<{ id: string; name: string; path: string; origin: string | null }>
  /** What `.teamree/relay` in the checkout says, or null when there is no file. */
  relayOnDisk: string | null
  /** Whether this machine's key is already committed there. */
  enrolled: boolean
  /** Why a publish cannot happen at all, in the runtime's own words. */
  blocker: string | null
  push:
    | { ok: true; upstream: string; setUpstream: boolean; alreadyUpToDate: boolean }
    | { ok: false; kind: string; error: string; advice: string }
  /**
   * Projects that answer `unread` the first time they are asked and `read`
   * afterwards, which is exactly the window a real reconcile leaves open.
   */
  unread: string[]
  /**
   * The origin a project added during the run reports. A clone sets one, so the
   * default is the repository the invitation named; null is a checkout somebody
   * pointed at with no remote on it.
   */
  addedOrigin: string | null
}

function world(overrides: Partial<World> = {}): World {
  return {
    projects: [{ id: 'p_api', name: 'api', path: '/repos/api', origin: ORIGIN }],
    relayOnDisk: RELAY_URL,
    enrolled: true,
    blocker: null,
    push: { ok: true, upstream: 'origin/main', setUpstream: false, alreadyUpToDate: false },
    unread: [],
    addedOrigin: ORIGIN,
    ...overrides
  }
}

function memberList(state: World): unknown {
  return {
    projectId: 'p_api',
    members: state.enrolled
      ? [{ handle: 'me', publicKey: 'key-me', addedAt: '2026-01-03', file: '.teamree/members/me.pub', isSelf: true }]
      : [],
    problems: [],
    self: { handle: 'me', publicKey: 'key-me' },
    selfFile: '.teamree/members/me.pub',
    enrolled: state.enrolled,
    watched: true,
    readAt: NOW
  }
}

function relaySetting(state: World): unknown {
  return {
    projectId: 'p_api',
    file: '.teamree/relay',
    url: state.relayOnDisk,
    source: state.relayOnDisk === null ? null : 'repository',
    problem: state.relayOnDisk === null ? 'no .teamree/relay in this checkout' : null,
    onDisk: { url: state.relayOnDisk, problem: state.relayOnDisk === null ? 'no file' : null },
    override: { name: 'TEAMREE_RELAY_URL', value: null },
    deploy: { command: 'teamree-relay deploy', reason: null },
    readAt: NOW
  }
}

function acceptHandler(state: World, overrides: Partial<Record<string, StubHandler>> = {}): StubHandler {
  return (method, params, context) => {
    const override = overrides[method]
    if (override) return override(method, params, context)
    switch (method) {
      case 'project.list':
        return state.projects.map((project) => ({
          id: project.id,
          name: project.name,
          path: project.path,
          baseRef: 'origin/main'
        }))
      case 'project.add': {
        const path = (params as { path: string }).path
        const name = (params as { name?: string }).name ?? 'added'
        const project = { id: 'p_new', name, path, origin: state.addedOrigin }
        state.projects.push(project)
        return { id: project.id, name, path, baseRef: 'origin/main' }
      }
      case 'teamwork.status': {
        const id = (params as { projectId: string }).projectId
        if (state.unread.includes(id)) {
          state.unread = state.unread.filter((other) => other !== id)
          return { state: 'unread', projectId: id, readAt: NOW }
        }
        const found = state.projects.find((project) => project.id === id)
        return {
          state: 'read',
          projectId: id,
          relay: state.relayOnDisk === null ? null : { url: state.relayOnDisk, source: 'repository' },
          disabledReason: null,
          origin:
            found?.origin == null
              ? { ok: false, reason: 'this checkout has no origin remote' }
              : { ok: true, url: found.origin },
          enrolled: state.enrolled,
          links: [],
          readAt: NOW
        }
      }
      case 'teamwork.setOrigin': {
        const url = (params as { url: string }).url
        for (const project of state.projects) if (project.origin === null) project.origin = url
        return { projectId: 'p_api', remote: 'origin', url, replaced: false }
      }
      case 'teamwork.relay':
        return relaySetting(state)
      case 'teamwork.setRelay':
        state.relayOnDisk = (params as { url: string }).url
        return relaySetting(state)
      case 'members.list':
        return memberList(state)
      case 'members.join':
        state.enrolled = true
        return memberList(state)
      case 'teamwork.publishPlan':
        return {
          projectId: 'p_api',
          files: ['.teamree/members/me.pub', '.teamree/relay'],
          message: 'Set up teamwork',
          remote: 'origin',
          branch: 'main',
          upstream: 'origin/main',
          committed: false,
          blocker: state.blocker,
          readAt: NOW
        }
      case 'teamwork.publish':
        return {
          projectId: 'p_api',
          files: ['.teamree/members/me.pub', '.teamree/relay'],
          commit: { sha: 'd'.repeat(40), shortSha: 'ddddddd', message: 'Add me to the team' },
          remote: 'origin',
          branch: 'main',
          push: state.push,
          at: NOW
        }
      default:
        throw new StubError('unknown_method', `no handler for ${method}`)
    }
  }
}

type Harness = {
  stub: StubRuntime
  cwd: string
  run: (argv: string[]) => Promise<{ code: number; out: string; err: string }>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** A scratch directory that goes away with the test that made it. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamree-accept-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function harness(handler: StubHandler): Promise<Harness> {
  const stub = await startStubRuntime(handler)
  cleanups.push(() => stub.close())
  const dir = scratch()
  writeFileSync(
    join(dir, 'runtime.json'),
    JSON.stringify({
      endpoint: stub.endpoint,
      pid: process.pid,
      version: '0.0.1',
      platform: process.platform,
      startedAt: Date.now()
    })
  )
  // A real working directory, because a clone runs git in it.
  const cwd = scratch()

  return {
    stub,
    cwd,
    run: async (argv) => {
      let out = ''
      let err = ''
      const streams: Streams = { out: (text) => (out += text), err: (text) => (err += text) }
      const code = await runCli(argv, { streams, env: { TEAMREE_USER_DATA_DIR: dir }, cwd })
      return { code, out, err }
    }
  }
}

function methodsCalled(stub: StubRuntime): string[] {
  return stub.received.map((call) => call.method)
}

function failureDocument(err: string): {
  error: { code: string; hint?: string; data: { steps: Array<{ step: string }> } }
} {
  return JSON.parse(err) as { error: { code: string; hint?: string; data: { steps: Array<{ step: string }> } } }
}

describe('team accept, on a checkout that is already here', () => {
  it('finds the project by its origin rather than by its name, and clones nothing', async () => {
    const cli = await harness(acceptHandler(world()))
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain('Found it here: api at /repos/api.')
    expect(methodsCalled(cli.stub)).not.toContain('project.add')
  })

  it('does every step that is left and says which ones were already done', async () => {
    const cli = await harness(acceptHandler(world({ relayOnDisk: null, enrolled: false })))
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(methodsCalled(cli.stub)).toContain('teamwork.setRelay')
    expect(methodsCalled(cli.stub)).toContain('members.join')
    expect(result.out).toContain('Wrote .teamree/relay: wss://relay.example/v1/relay.')
    expect(result.out).toContain('Wrote .teamree/members/me.pub')
    expect(result.out).toContain('Committed ddddddd')
  })

  it('writes neither file again when both are already in the checkout', async () => {
    const cli = await harness(acceptHandler(world()))
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.out).toContain('.teamree/relay already names wss://relay.example/v1/relay.')
    expect(result.out).toContain('already on the roster as me')
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.setRelay')
    expect(methodsCalled(cli.stub)).not.toContain('members.join')
  })

  it('ends by saying a key was pushed and refuses to call that a teammate being there', async () => {
    const cli = await harness(acceptHandler(world()))
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.out).toContain('api is set up and your key is in the repository.')
    expect(result.out).toContain('Nobody is known to be connected')
    expect(result.out).toContain('teamree team status api')
  })

  it('leaves the origin alone on a checkout that already names the right repository', async () => {
    const cli = await harness(acceptHandler(world()))
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.setOrigin')
  })

  it('sets an origin on a checkout it cloned itself, which is the only one it will', async () => {
    const source = scratch()
    const repository = join(source, 'api.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', repository], { stdio: 'ignore' })

    const cli = await harness(acceptHandler(world({ projects: [], addedOrigin: null })))
    const link = formatInvitation({ origin: repository, relay: RELAY_URL, project: 'api', from: 'ana' })
    const result = await cli.run(['team', 'accept', link, '--into', join(cli.cwd, 'api')])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(methodsCalled(cli.stub)).toContain('teamwork.setOrigin')
  }, 30_000)
})

describe('team accept, when it must not go on', () => {
  it('refuses a string that is not an invitation and names the command that writes one', async () => {
    const cli = await harness(acceptHandler(world()))
    const result = await cli.run(['team', 'accept', 'have a look at this repo'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('That is not a teamree invitation')
    expect(result.err).toContain('teamree team invite')
    expect(result.out).toBe('')
  })

  it('refuses an invitation written by a teamree it does not understand', async () => {
    const cli = await harness(acceptHandler(world()))
    const result = await cli.run(['team', 'accept', LINK.replace('v=1', 'v=2')])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('version 2 invitation')
    expect(result.err).toContain('reads version 1')
  })

  it('refuses a checkout whose origin names a different repository, and changes nothing', async () => {
    const cli = await harness(acceptHandler(world({ projects: [], addedOrigin: 'https://github.com/acme/other.git' })))
    const into = scratch()
    const result = await cli.run(['team', 'accept', LINK, '--into', into])
    expect(result.code).toBe(ExitCode.Failure)
    // Both addresses, because the whole content of this refusal is that they differ.
    expect(result.err).toContain('https://github.com/acme/other.git')
    expect(result.err).toContain('https://github.com/acme/api.git')
    expect(result.err).toContain('two different projects')
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.setOrigin')
    expect(methodsCalled(cli.stub)).not.toContain('members.join')
  })

  it('refuses to overwrite a relay the checkout already names, and says why that matters', async () => {
    const cli = await harness(acceptHandler(world({ relayOnDisk: 'wss://other.example/v1/relay' })))
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('wss://other.example/v1/relay')
    expect(result.err).toContain('wss://relay.example/v1/relay')
    expect(result.err).toContain('Settle which relay it is, then run this again.')
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.setRelay')
  })

  it('passes a blocked publish on in the runtime’s own words and says the rest is done', async () => {
    const cli = await harness(
      acceptHandler(
        world({ blocker: 'This checkout is not on a branch, so there is nothing to push. Check one out first.' })
      )
    )
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('not on a branch')
    expect(result.err).toContain('teamree team publish api')
  })

  it('says plainly that the invitation granted no push access when the remote refuses this machine', async () => {
    const cli = await harness(
      acceptHandler(
        world({
          push: {
            ok: false,
            kind: 'auth',
            error: 'remote: Permission to acme/api.git denied',
            advice: 'Add the key to your agent.'
          }
        })
      )
    )
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('remote: Permission to acme/api.git denied')
    expect(result.err).toContain('You need push access to https://github.com/acme/api.git')
    expect(result.err).toContain('the invitation grants none')
  })

  it('refuses an origin that names a transport rather than an address, and starts no git', async () => {
    // `ext::<command>` is git remote syntax that names a program rather than a
    // place. The allowlist that refuses it is `checkTransport` in
    // `src/shared/origin.ts`, reached from here through `checkCloneable`; what
    // this test is about is that the refusal lands before anything is executed
    // or written.
    const cli = await harness(acceptHandler(world({ projects: [] })))
    const hostile = formatInvitation({ origin: 'ext::sh', relay: RELAY_URL, project: 'api', from: 'ana' })
    const result = await cli.run(['team', 'accept', hostile, '--into', join(cli.cwd, 'api')])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('not a transport teamree hands git')
    expect(existsSync(join(cli.cwd, 'api'))).toBe(false)
    expect(methodsCalled(cli.stub)).not.toContain('project.add')
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.setOrigin')
  })

  it('says out loud when it replaced a relay file nothing could read', async () => {
    const cli = await harness(acceptHandler(world({ relayOnDisk: 'not a url at all' })))
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain('It replaced what was there, which could not be read as a relay URL')
  })

  it('refuses rather than guess when two projects here already have that origin', async () => {
    const cli = await harness(
      acceptHandler(
        world({
          projects: [
            { id: 'p_api', name: 'api', path: '/repos/api', origin: ORIGIN },
            { id: 'p_api2', name: 'api-again', path: '/repos/api-again', origin: ORIGIN }
          ]
        })
      )
    )
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('api, api-again')
    expect(result.err).toContain('Nothing was changed')
  })

  it('names the environment override when the relay it just wrote is not the one this machine dials', async () => {
    const state = world({ relayOnDisk: null })
    const cli = await harness(
      acceptHandler(state, {
        'teamwork.setRelay': () => ({
          projectId: 'p_api',
          file: '.teamree/relay',
          url: 'wss://tunnel.example/v1/relay',
          source: 'environment',
          problem: null,
          onDisk: { url: RELAY_URL, problem: null },
          override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' },
          deploy: { command: 'teamree-relay deploy', reason: null },
          readAt: NOW
        })
      })
    )
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain('TEAMREE_RELAY_URL is set in this app’s environment')
    expect(result.out).toContain('keeps dialling wss://tunnel.example/v1/relay')
  })

  it('refuses a --into that starts with a ~, because that is a different directory per account', async () => {
    const cli = await harness(acceptHandler(world({ projects: [] })))
    const result = await cli.run(['team', 'accept', LINK, '--into', '~/src/api'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('starts with a ~')
    expect(result.err).toContain('Give the path in full')
  })
})

describe('what accept says about the push', () => {
  it('does not claim the remote already had the branch when the push delivered something', async () => {
    const cli = await harness(
      acceptHandler(world({ push: { ok: true, upstream: 'origin/main', setUpstream: true, alreadyUpToDate: false } }), {
        'teamwork.publish': () => ({
          projectId: 'p_api',
          files: ['.teamree/members/me.pub'],
          // No new commit here, and a push that still carried the user's own
          // work. The two are different facts and were being reported as one.
          commit: null,
          remote: 'origin',
          branch: 'main',
          push: { ok: true, upstream: 'origin/main', setUpstream: true, alreadyUpToDate: false },
          at: NOW
        })
      })
    )
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain('Nothing new to commit here; pushed main to origin')
    expect(result.out).not.toContain('already had')
  })

  it('says so when the remote really did already have it', async () => {
    const cli = await harness(
      acceptHandler(world({ push: { ok: true, upstream: 'origin/main', setUpstream: false, alreadyUpToDate: true } }))
    )
    const result = await cli.run(['team', 'accept', LINK])
    expect(result.out).toContain('origin already had main')
  })
})

describe('team accept and --json', () => {
  it('prints exactly one document, with the steps it took in order', async () => {
    const cli = await harness(acceptHandler(world({ relayOnDisk: null, enrolled: false })))
    const result = await cli.run(['team', 'accept', LINK, '--json'])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.err).toBe('')
    const lines = result.out.split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    const document = JSON.parse(lines[0] as string) as {
      ok: boolean
      command: string
      data: { steps: Array<{ step: string }> }
    }
    expect(document.ok).toBe(true)
    expect(document.command).toBe('team accept')
    expect(document.data.steps.map((step) => step.step)).toEqual([
      'link',
      'repository',
      'project',
      'origin',
      'relay',
      'roster',
      'publish'
    ])
  })

  it('carries the steps it had already taken out through the refusal as well', async () => {
    const cli = await harness(acceptHandler(world({ relayOnDisk: 'wss://other.example/v1/relay' })))
    const result = await cli.run(['team', 'accept', LINK, '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.out).toBe('')
    const document = failureDocument(result.err)
    expect(document.error.code).toBe('relay_mismatch')
    // The difference between "nothing happened" and "it stopped at the relay".
    expect(document.error.data.steps.map((step) => step.step)).toEqual(['link', 'repository', 'project', 'origin'])
  })

  it('keeps the steps on a refusal the runtime raised rather than this command', async () => {
    const cli = await harness(
      acceptHandler(world({ enrolled: false }), {
        'members.join': () => {
          throw new StubError(
            'invalid_params',
            'git has no user.email configured in /repos/api, so there is no name to file your key under'
          )
        }
      })
    )
    const result = await cli.run(['team', 'accept', LINK, '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    const document = failureDocument(result.err)
    expect(document.error.code).toBe('invalid_params')
    expect(document.error.data.steps.map((step) => step.step)).toEqual([
      'link',
      'repository',
      'project',
      'origin',
      'relay'
    ])
  })
})

describe('team accept, when the repository is not on this machine', () => {
  it('clones it, adds it under the name the invitation used, and goes on', async () => {
    const source = scratch()
    const repository = join(source, 'api.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', repository], { stdio: 'ignore' })

    const cli = await harness(acceptHandler(world({ projects: [], addedOrigin: repository })))
    const into = join(cli.cwd, 'api')
    const link = formatInvitation({ origin: repository, relay: RELAY_URL, project: 'api', from: 'ana' })

    const result = await cli.run(['team', 'accept', link, '--into', into])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(existsSync(join(into, '.git'))).toBe(true)
    expect(result.out).toContain('so this cloned')
    expect(cli.stub.received.find((call) => call.method === 'project.add')).toMatchObject({
      params: { path: into, name: 'api' }
    })
  }, 30_000)

  it('clones a file:// origin at the path it names, rather than refusing its scheme', async () => {
    const source = scratch()
    const repository = join(source, 'api.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', repository], { stdio: 'ignore' })

    // `checkOrigin` turns a file:// URL into the path it names, and that path is
    // what git is given. Handing git the URL instead would be refused by the
    // transport allowlist, for a repository that is perfectly ordinary.
    const cli = await harness(acceptHandler(world({ projects: [], addedOrigin: repository })))
    const into = join(cli.cwd, 'api')
    const link = formatInvitation({ origin: `file://${repository}`, relay: RELAY_URL, project: 'api', from: 'ana' })

    const result = await cli.run(['team', 'accept', link, '--into', into])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(existsSync(join(into, '.git'))).toBe(true)
  }, 30_000)

  it('does not write down a clone that did not happen', async () => {
    const cli = await harness(acceptHandler(world({ projects: [] })))
    const missing = join(cli.cwd, 'nowhere.git')
    const link = formatInvitation({ origin: missing, relay: RELAY_URL, project: 'api', from: 'ana' })

    const result = await cli.run(['team', 'accept', link, '--into', join(cli.cwd, 'api'), '--json'])
    expect(result.code).toBe(ExitCode.Failure)
    const document = failureDocument(result.err)
    expect(document.error.code).toBe('clone_failed')
    expect(document.error.data.steps.map((step) => step.step)).toEqual(['link'])
  }, 30_000)

  it('reports git’s own words when the clone does not happen', async () => {
    const cli = await harness(acceptHandler(world({ projects: [] })))
    const missing = join(cli.cwd, 'nowhere.git')
    const link = formatInvitation({ origin: missing, relay: RELAY_URL, project: 'api', from: 'ana' })

    const result = await cli.run(['team', 'accept', link, '--into', join(cli.cwd, 'api')])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err.toLowerCase()).toContain('repository')
    expect(methodsCalled(cli.stub)).not.toContain('project.add')
  }, 30_000)

  it('adopts a directory that is already there when its origin says it is the right one', async () => {
    const cli = await harness(acceptHandler(world({ projects: [] })))
    const into = join(cli.cwd, 'api')
    mkdirSync(into)

    const result = await cli.run(['team', 'accept', LINK, '--into', into])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain(`${into} is already here, so nothing was cloned.`)
    expect(methodsCalled(cli.stub)).toContain('project.add')
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.setOrigin')
  })

  it('refuses to point a checkout it found at an address out of a link, and pushes nothing', async () => {
    // The worst thing this command could do. A local-only repository — notes,
    // dotfiles, a scratch clone with no remote — sitting under a directory name
    // the link itself chose, given an origin the link names and then pushed,
    // sends its whole history to whoever wrote the link.
    const cli = await harness(acceptHandler(world({ projects: [], addedOrigin: null })))
    const into = join(cli.cwd, 'api')
    mkdirSync(into)

    const result = await cli.run(['team', 'accept', LINK, '--into', into])
    expect(result.code).toBe(ExitCode.Failure)
    expect(result.err).toContain('Nothing says it is the repository this invitation names')
    expect(result.err).toContain('--into naming a path that does not exist yet')
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.setOrigin')
    expect(methodsCalled(cli.stub)).not.toContain('members.join')
    expect(methodsCalled(cli.stub)).not.toContain('teamwork.publish')
  })

  it('refuses a --into that names no directory at all', async () => {
    const cli = await harness(acceptHandler(world({ projects: [] })))
    for (const value of ['', '.']) {
      const result = await cli.run(['team', 'accept', LINK, '--into', value])
      expect(result.code, `--into "${value}"`).toBe(ExitCode.Failure)
      expect(result.err).toContain('--into names no directory')
    }
  })

  it('finds the project that already tracks the checkout when adding it is refused as a duplicate', async () => {
    const into = scratch()
    const cli = await harness(
      acceptHandler(
        world({ projects: [{ id: 'p_api', name: 'api', path: into, origin: ORIGIN }], unread: ['p_api'] }),
        {
          'project.add': () => {
            throw new StubError('conflict', '"api" already tracks the checkout')
          }
        }
      )
    )
    // The checkout is here and had not been read when the origins were compared,
    // so it was not matched; adding it comes back as a conflict, and the project
    // it collided with is the answer rather than the failure.
    const result = await cli.run(['team', 'accept', LINK, '--into', into])
    expect(result.code, result.err).toBe(ExitCode.Success)
    expect(result.out).toContain(`api already tracks ${into}.`)
    expect(result.out).toContain('teamree has not read api yet')
  })
})
