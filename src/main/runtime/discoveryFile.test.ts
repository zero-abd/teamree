import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../shared/protocol'
import { discoveryFilePath, readDiscoveryFile, removeDiscoveryFile, writeDiscoveryFile } from './discoveryFile'
import { resolveEndpoint } from './socketEndpoint'

describe('discovery file', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-discovery-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('round-trips what the CLI needs to connect', async () => {
    const path = discoveryFilePath(directory)
    await writeDiscoveryFile(path, { endpoint: '/tmp/x.sock', pid: 4242, version: '0.0.1', startedAt: 17 })

    expect(await readDiscoveryFile(path)).toEqual({
      endpoint: '/tmp/x.sock',
      pid: 4242,
      version: '0.0.1',
      startedAt: 17,
      protocolVersion: PROTOCOL_VERSION
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: 4242 })

    await removeDiscoveryFile(path)
    expect(await readDiscoveryFile(path)).toBeUndefined()
  })

  it('ignores a file it cannot trust', async () => {
    const path = discoveryFilePath(directory)
    await writeFile(path, '{ not json', 'utf8')
    expect(await readDiscoveryFile(path)).toBeUndefined()

    await writeFile(path, JSON.stringify({ endpoint: '', pid: 0 }), 'utf8')
    expect(await readDiscoveryFile(path)).toBeUndefined()
  })

  it('names a pipe on Windows and a socket everywhere else', () => {
    expect(resolveEndpoint('C:\\Users\\a\\teamree', 'win32')).toMatch(/^\\\\\.\\pipe\\teamree-[0-9a-f]{12}$/)
    expect(resolveEndpoint('/home/a/.config/teamree', 'linux')).toBe('/home/a/.config/teamree/runtime.sock')
  })

  it('falls back to a short path when the user data dir is too deep to bind', () => {
    const deep = `/Users/someone/${'nested/'.repeat(20)}teamree`
    expect(resolveEndpoint(deep, 'darwin').startsWith(deep)).toBe(false)
    expect(resolveEndpoint(deep, 'darwin')).toMatch(/teamree-[0-9a-f]{12}\.sock$/)
  })
})
