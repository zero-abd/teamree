import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_FILE_NAME,
  discoveryPath,
  findRuntime,
  isPipe,
  isProcessAlive,
  isStale,
  parseDiscoveryRecord,
  requireRuntime,
  userDataDir,
  type DiscoveryHost
} from './discovery.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { NoRuntimeError } from './exit.js'

const RECORD = { endpoint: '/tmp/teamree.sock', pid: 4242, version: '0.0.1', platform: 'darwin', startedAt: 1 }

function makeHost(overrides: Partial<DiscoveryHost> & { files?: Record<string, string> } = {}): DiscoveryHost {
  const files = overrides.files ?? {}
  return {
    platform: overrides.platform ?? 'darwin',
    env: overrides.env ?? {},
    home: overrides.home ?? '/home/dev',
    readFile: overrides.readFile ?? ((path) => files[path]),
    pathExists: overrides.pathExists ?? ((path) => path in files || path === RECORD.endpoint),
    isProcessAlive: overrides.isProcessAlive ?? (() => true)
  }
}

describe('userDataDir', () => {
  it('matches the Electron directory on each platform', () => {
    expect(userDataDir({ platform: 'darwin', env: {}, home: '/Users/dev' })).toBe(
      '/Users/dev/Library/Application Support/teamree'
    )
    expect(userDataDir({ platform: 'linux', env: {}, home: '/home/dev' })).toBe('/home/dev/.config/teamree')
    expect(userDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/dev' })).toBe('/xdg/teamree')
    expect(
      userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, home: 'C:\\Users\\dev' })
    ).toContain('teamree')
    expect(userDataDir({ platform: 'win32', env: {}, home: 'C:/Users/dev' })).toContain('Roaming')
  })

  it('honours an explicit override', () => {
    expect(userDataDir({ platform: 'darwin', env: { TEAMREE_USER_DATA_DIR: '/custom' }, home: '/x' })).toBe('/custom')
  })
})

describe('discoveryPath', () => {
  it("sits in the user data dir under the runtime's own file name", () => {
    expect(discoveryPath({ platform: 'linux', env: {}, home: '/home/dev' })).toBe(
      `/home/dev/.config/teamree/${DISCOVERY_FILE_NAME}`
    )
  })

  it('uses TEAMREE_RUNTIME_FILE when set', () => {
    expect(discoveryPath({ platform: 'linux', env: { TEAMREE_RUNTIME_FILE: '/tmp/x.json' }, home: '/h' })).toBe(
      '/tmp/x.json'
    )
  })
})

describe('isPipe', () => {
  it('recognises Windows named pipes', () => {
    expect(isPipe('\\\\.\\pipe\\teamree-abc')).toBe(true)
    expect(isPipe('/tmp/teamree.sock')).toBe(false)
  })
})

describe('parseDiscoveryRecord', () => {
  it('accepts a well-formed record and ignores unknown fields', () => {
    const parsed = parseDiscoveryRecord(JSON.stringify({ ...RECORD, extra: true }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.record.endpoint).toBe(RECORD.endpoint)
  })

  it('rejects non-JSON', () => {
    const parsed = parseDiscoveryRecord('{ not json')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain('not valid JSON')
  })

  it('rejects a record with a missing or nonsense field', () => {
    expect(parseDiscoveryRecord(JSON.stringify({ pid: 1, version: '1' })).ok).toBe(false)
    expect(parseDiscoveryRecord(JSON.stringify({ ...RECORD, pid: 0 })).ok).toBe(false)
    expect(parseDiscoveryRecord(JSON.stringify({ ...RECORD, pid: 1.5 })).ok).toBe(false)
    expect(parseDiscoveryRecord(JSON.stringify({ ...RECORD, endpoint: '' })).ok).toBe(false)
    const named = parseDiscoveryRecord(JSON.stringify({ ...RECORD, endpoint: 12 }))
    if (!named.ok) expect(named.message).toContain('endpoint')
  })
})

describe('isStale', () => {
  it('is stale when the process is gone', () => {
    expect(isStale(RECORD, makeHost({ isProcessAlive: () => false }))).toMatch(/4242 is no longer running/)
  })

  it('is stale when the socket file has been removed', () => {
    expect(isStale(RECORD, makeHost({ pathExists: () => false }))).toMatch(/no longer exists/)
  })

  it('does not stat named pipes on Windows', () => {
    const host = makeHost({ platform: 'win32', pathExists: () => false })
    expect(isStale({ ...RECORD, endpoint: '\\\\.\\pipe\\teamree' }, host)).toBeNull()
  })

  it('is fresh when the process and socket are both there', () => {
    expect(isStale(RECORD, makeHost())).toBeNull()
  })
})

describe('findRuntime', () => {
  const path = '/home/dev/.config/teamree/runtime.json'
  const linux = { platform: 'linux' as const, home: '/home/dev' }

  it('reads the first usable file', () => {
    const outcome = findRuntime(makeHost({ ...linux, files: { [path]: JSON.stringify(RECORD) } }))
    expect(outcome).toMatchObject({ ok: true, endpoint: RECORD.endpoint, source: path })
  })

  it('reports nothing found', () => {
    const outcome = findRuntime(makeHost({ ...linux }))
    expect(outcome).toMatchObject({ ok: false, reason: 'missing' })
    if (!outcome.ok) expect(outcome.checked).toContain(path)
  })

  it('reports a stale file rather than dialling a dead socket', () => {
    const host = makeHost({ ...linux, files: { [path]: JSON.stringify(RECORD) }, isProcessAlive: () => false })
    expect(findRuntime(host)).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('reports a malformed file', () => {
    const host = makeHost({ ...linux, files: { [path]: 'nope' } })
    expect(findRuntime(host)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('lets TEAMREE_ENDPOINT win outright', () => {
    const host = makeHost({ ...linux, env: { TEAMREE_ENDPOINT: '/tmp/forced.sock' }, isProcessAlive: () => false })
    expect(findRuntime(host)).toMatchObject({ ok: true, endpoint: '/tmp/forced.sock', source: 'TEAMREE_ENDPOINT' })
  })
})

describe('requireRuntime', () => {
  it('throws exit code 3 with a way forward', () => {
    try {
      requireRuntime(makeHost({ platform: 'linux', home: '/home/dev' }))
      throw new Error('expected a no-runtime error')
    } catch (error) {
      expect(error).toBeInstanceOf(NoRuntimeError)
      expect((error as NoRuntimeError).exitCode).toBe(3)
      expect((error as NoRuntimeError).hint).toMatch(/npm run dev/)
      expect((error as NoRuntimeError).message).toMatch(/not running/)
    }
  })

  it('rejects a runtime speaking another protocol version, without claiming it is absent', () => {
    const path = '/home/dev/.config/teamree/runtime.json'
    const host = makeHost({
      platform: 'linux',
      home: '/home/dev',
      files: { [path]: JSON.stringify({ ...RECORD, protocolVersion: 99 }) }
    })
    try {
      requireRuntime(host)
      throw new Error('expected a protocol error')
    } catch (error) {
      expect((error as NoRuntimeError).exitCode).toBe(1)
      expect((error as NoRuntimeError).message).toMatch(/protocol 99/)
    }
  })

  it('accepts the protocol version this CLI was built against', () => {
    const path = '/home/dev/.config/teamree/runtime.json'
    const host = makeHost({
      platform: 'linux',
      home: '/home/dev',
      files: { [path]: JSON.stringify({ ...RECORD, protocolVersion: PROTOCOL_VERSION }) }
    })
    expect(requireRuntime(host).endpoint).toBe(RECORD.endpoint)
  })

  it('names staleness in the message', () => {
    const path = '/home/dev/.config/teamree/runtime.json'
    const host = makeHost({
      platform: 'linux',
      home: '/home/dev',
      files: { [path]: JSON.stringify(RECORD) },
      isProcessAlive: () => false
    })
    expect(() => requireRuntime(host)).toThrow(/stale/)
  })
})

describe('isProcessAlive', () => {
  it('sees this process and not an impossible pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0x7ffffff0)).toBe(false)
  })
})
