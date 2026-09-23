import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { byteRange, FileGrants, serveGrantedFile } from './fileProtocol'

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'teamree-proto-'))
  outside = await mkdtemp(path.join(tmpdir(), 'teamree-proto-out-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const get = (grants: FileGrants, url: string, range?: string) =>
  serveGrantedFile(grants, { url, headers: new Headers(range === undefined ? {} : { range }) })

describe('file grants', () => {
  it('names a grant by token, reuses it per file, and forgets the oldest past the limit', () => {
    let next = 0
    const grants = new FileGrants(2, () => `t${++next}`)
    const a = grants.grant({ root, absolute: path.join(root, 'a b.png'), mime: 'image/png' }, 10.4)
    expect(a).toBe('teamree-file://grant/t1/a%20b.png?v=10')
    expect(grants.grant({ root, absolute: path.join(root, 'a b.png'), mime: 'image/png' }, 11)).toContain('/t1/')
    grants.grant({ root, absolute: path.join(root, 'b.png'), mime: 'image/png' }, 1)
    grants.grant({ root, absolute: path.join(root, 'c.png'), mime: 'image/png' }, 1)
    expect(grants.lookup(a)).toBeNull()
    expect(grants.lookup('teamree-file://grant/t3/c.png')?.absolute).toBe(path.join(root, 'c.png'))
    expect(grants.lookup('https://grant/t3/c.png')).toBeNull()
  })
})

describe('byteRange', () => {
  it('reads the forms a media element sends', () => {
    expect(byteRange(null, 100)).toBeNull()
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(byteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable')
  })
})

describe('serveGrantedFile', () => {
  it('serves a granted file whole and by range, with its type', async () => {
    await writeFile(path.join(root, 'a.png'), '0123456789')
    const grants = new FileGrants()
    const url = grants.grant({ root, absolute: path.join(root, 'a.png'), mime: 'image/png' }, 1)
    const whole = await get(grants, url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('image/png')
    expect(await whole.text()).toBe('0123456789')
    const part = await get(grants, url, 'bytes=2-4')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await part.text()).toBe('234')
  })

  it('refuses an unknown grant, and a granted path swapped for a link out', async () => {
    await writeFile(path.join(outside, 'secret.png'), 'no')
    await writeFile(path.join(root, 'a.png'), 'yes')
    const grants = new FileGrants()
    const url = grants.grant({ root, absolute: path.join(root, 'a.png'), mime: 'image/png' }, 1)
    expect((await get(grants, 'teamree-file://grant/nope/a.png')).status).toBe(404)
    await unlink(path.join(root, 'a.png'))
    await symlink(path.join(outside, 'secret.png'), path.join(root, 'a.png'))
    expect((await get(grants, url)).status).toBe(403)
  })

  it('sandboxes an SVG', async () => {
    await writeFile(path.join(root, 'a.svg'), '<svg/>')
    const grants = new FileGrants()
    const url = grants.grant({ root, absolute: path.join(root, 'a.svg'), mime: 'image/svg+xml' }, 1)
    expect((await get(grants, url)).headers.get('content-security-policy')).toContain('sandbox')
  })
})
