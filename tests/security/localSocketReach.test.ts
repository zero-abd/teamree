// The other boundary. Everything else in this directory probes what a teammate
// across a relay can reach; this file probes what something on *this machine*
// can reach, which is a different question with a much shorter answer.
//
// `peerTransport.ts` hands a teammate six methods. The socket in
// `socketServer.ts` hands its caller the catalogue — every method the window
// itself uses, including the ones that create and remove worktrees, spawn
// terminals, read a pane's scrollback and type into it. That is deliberate and
// is the product: the CLI is how a coding agent drives the app. It does mean
// the local socket is strictly more powerful than any peer link, and so the
// only thing standing between the catalogue and a caller is the endpoint's own
// permissions.
//
// Nothing here is an exploit. It is the record of what was probed and held: the
// asymmetry stated out loud so nobody mistakes `PEER_METHODS` for a limit on
// the CLI, the endpoint's mode, and the contents of the file that advertises
// it. The threat model these hold up — and what none of them can defend, which
// is anything already running as you — is written down in docs/local-access.md.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PEER_METHODS } from '../../src/main/runtime/peerTransport'
import { DISCOVERY_FILE_NAME } from '../../src/main/runtime/discoveryFile'
import { resolveEndpoint } from '../../src/main/runtime/socketEndpoint'
import { ENDPOINT_MODE } from '../../src/main/runtime/socketServer'
import { startRuntime, type Runtime } from '../../src/main/runtime/startRuntime'
import { createFrameDecoder, type Response } from '../../src/shared/protocol'

/** One request over the real socket, answered by the real dispatcher. */
function callOverSocket(endpoint: string, method: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(endpoint)
    const decode = createFrameDecoder()
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: Buffer | string) => {
      const frames = decode(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      const response = frames.find((frame) => (frame as Response).id === '1')
      if (response) {
        socket.destroy()
        resolve(response as Response)
      }
    })
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: '1', method, params: {} })}\n`))
  })
}

let userDataDir: string
let runtime: Runtime

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'teamree-sec-local-'))
  runtime = await startRuntime({
    userDataDir,
    version: 'test',
    serveCli: true,
    // No Electron in a vitest worker, and nothing here may dial a relay or GitHub.
    serveRenderer: false,
    serveTeamwork: false,
    checkForUpdates: false,
    onError: () => undefined
  })
}, 30_000)

afterAll(async () => {
  await runtime?.stop()
  await rm(userDataDir, { recursive: true, force: true })
})

describe('what the local socket hands out', () => {
  it('serves the whole catalogue, which is exactly what the peer surface does not', () => {
    const catalogue = runtime.registry.methods()
    // Not a number to keep in step — the relation is the claim. Every method a
    // teammate may call is on the socket too, and the socket carries many more.
    for (const method of Object.keys(PEER_METHODS)) expect(catalogue).toContain(method)
    expect(catalogue.length).toBeGreaterThan(Object.keys(PEER_METHODS).length * 5)

    // What "more powerful than any peer link" actually means, named rather than
    // left to the reader: a teammate cannot make a worktree, remove one, open a
    // pane or drop a project, and a CLI client does all four.
    for (const method of ['worktree.create', 'worktree.remove', 'terminal.create', 'project.remove']) {
      expect(catalogue).toContain(method)
      expect(PEER_METHODS).not.toHaveProperty(method)
    }

    // And the one they share is not shared on equal terms. A teammate's
    // `terminal.write` is scoped `write-pane`, which is what sends it through
    // the owner's verdict in peerTransport.ts before a byte reaches the pty. A
    // CLI client's goes to the same handler with nothing in front of it — there
    // is no scope on this transport to put anything behind. Keystrokes from the
    // socket are the user's own, and nobody is asked to consent to themselves.
    expect(PEER_METHODS['terminal.write']).toBe('write-pane')
    expect(catalogue).toContain('terminal.write')
  })

  it('applies no allow-list to a client that got through the door', async () => {
    // `project.list` is on no peer's list and is answered here without ceremony.
    // The asymmetry above is a fact about two tables; this is the same fact
    // observed over an actual connection to the running runtime.
    const response = await callOverSocket(runtime.endpoint, 'project.list')
    expect(response.ok).toBe(true)
  })
})

describe('who may open it', () => {
  it('listens on an endpoint no other account may connect to', async () => {
    expect((await stat(runtime.endpoint)).mode & 0o777).toBe(ENDPOINT_MODE)
  })

  it('puts that endpoint inside the app data directory rather than a shared one', () => {
    // The mode above is the app's own defence; this is the one it inherits, and
    // it is the stronger of the two — a directory other accounts cannot enter
    // cannot be reasoned about by anything they run. It is asserted here as the
    // *choice* of location, which is this repository's to make. That the
    // directory is itself owner-only is Electron's doing, is asserted against a
    // real app launch in scripts/smoke.mjs, and is the thing this claim rests on.
    expect(runtime.endpoint).toBe(join(userDataDir, 'runtime.sock'))
    expect(runtime.endpoint).toBe(resolveEndpoint(userDataDir))
  })
})

describe('what the discovery file gives away', () => {
  it('carries nothing a reader could not already have worked out', async () => {
    const raw = JSON.parse(await readFile(join(userDataDir, DISCOVERY_FILE_NAME), 'utf8')) as Record<string, unknown>

    // Asserted whole, so a field that *is* a secret — a token, a key, a
    // one-time handle — cannot be added to this file without this going red.
    // It is the argument for why `runtime.json` is left at the mode the umask
    // gives it while the socket beside it is not: the socket is a way in, and
    // this is a signpost to one.
    expect(Object.keys(raw).sort()).toEqual(['endpoint', 'pid', 'protocolVersion', 'startedAt', 'version'])

    // Both of the two that could conceivably be sensitive are derivable without
    // the file: the endpoint is a pure function of the user data directory, and
    // the pid is in the process table for anyone who runs `ps`.
    expect(raw['endpoint']).toBe(resolveEndpoint(userDataDir))
    expect(raw['pid']).toBe(process.pid)
  })
})
