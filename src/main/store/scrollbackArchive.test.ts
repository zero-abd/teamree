import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INERT_RECORD } from '../terminals/scrollbackRecord'
import { MAX_RECORD_BYTES, MAX_RECORD_FILE_BYTES, ScrollbackArchive } from './scrollbackArchive'

const ESC = '\x1b'
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function archive(keep: string[] = [], problems: string[] = []): Promise<ScrollbackArchive> {
  const base = await mkdtemp(join(tmpdir(), 'teamree-scrollback-'))
  directories.push(base)
  return ScrollbackArchive.open(join(base, 'scrollback'), keep, { onProblem: (reason) => problems.push(reason) })
}

describe('ScrollbackArchive', () => {
  it('gives back what a pane printed', async () => {
    const store = await archive()
    store.put('term_1', 'built in 4.2s\r\n')
    await store.flush()

    expect(store.read('term_1')?.text).toBe('built in 4.2s\r\n')
    expect(store.read('term_1')?.endedAt).toBeGreaterThan(0)
  })

  it('has nothing to say about a pane it never heard of', async () => {
    const store = await archive()
    expect(store.read('term_missing')).toBeUndefined()
  })

  it('keeps the end of a pane that printed more than the cap', async () => {
    const store = await archive()
    const lines = Array.from({ length: 40_000 }, (_, index) => `line ${index}\r\n`).join('')
    expect(Buffer.byteLength(lines, 'utf8')).toBeGreaterThan(MAX_RECORD_BYTES)

    store.put('term_1', lines)
    await store.flush()

    const kept = store.read('term_1')
    expect(kept).toBeDefined()
    expect(Buffer.byteLength(kept?.text ?? '', 'utf8')).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    expect(kept?.text.endsWith('line 39999\r\n')).toBe(true)
    expect(kept?.text).not.toContain('line 0\r\n')

    // On disk as well as in memory: the cap is what stops a pane that printed a
    // gigabyte from being a gigabyte in the app's data directory.
    const [name] = await readdir(store.directory)
    const bytes = (await readFile(join(store.directory, name as string))).byteLength
    expect(bytes).toBeLessThan(MAX_RECORD_FILE_BYTES)
  })

  it('writes a file that cannot reprogram a terminal that reads it', async () => {
    const store = await archive()
    store.put('term_1', `${ESC}]52;c;ZXZpbA==\x07${ESC}[6ntests ${ESC}[32mpassed${ESC}[0m\r\n`)
    await store.flush()

    const onDisk = await readFile(join(store.directory, 'term_1.json'), 'utf8')
    expect(onDisk).not.toContain('52;c')
    expect(onDisk).not.toContain('[6n')
    expect(store.read('term_1')?.text).toBe(`tests ${ESC}[32mpassed${ESC}[0m\r\n`)
  })

  // The file is the boundary whatever wrote it. A record sanitised on the way in
  // and trusted on the way out would be one edit away from being live again.
  it('sanitises a file it did not write, on the way back', async () => {
    const store = await archive()
    store.put('term_1', 'placeholder\r\n')
    await store.flush()
    await writeFile(
      join(store.directory, 'term_1.json'),
      JSON.stringify({ version: 1, endedAt: 1, text: `${ESC}[6n${ESC}]0;renamed\x07still here` }),
      'utf8'
    )

    const kept = store.read('term_1')
    expect(kept?.text).toBe('still here')
    expect(kept?.text).toMatch(INERT_RECORD)
  })

  it('opens a pane with nothing above the prompt rather than failing on a bad file', async () => {
    const problems: string[] = []
    const store = await archive([], problems)
    store.put('term_1', 'placeholder\r\n')
    await store.flush()

    await writeFile(join(store.directory, 'term_1.json'), '{ this is not json', 'utf8')
    expect(store.read('term_1')).toBeUndefined()
    expect(problems.join(' ')).toContain('term_1')

    // And a file of the right shape holding the wrong thing.
    await writeFile(join(store.directory, 'term_1.json'), JSON.stringify({ text: 42 }), 'utf8')
    expect(store.read('term_1')).toBeUndefined()
  })

  it('refuses a file too big to be one of its own', async () => {
    const problems: string[] = []
    const store = await archive([], problems)
    store.put('term_1', 'placeholder\r\n')
    await store.flush()
    await writeFile(join(store.directory, 'term_1.json'), 'x'.repeat(MAX_RECORD_FILE_BYTES + 1), 'utf8')

    expect(store.read('term_1')).toBeUndefined()
    expect(problems.join(' ')).toContain('past the')
  })

  // A terminal id is read out of a file this app deliberately does not trust,
  // and it is about to be part of a path.
  it('refuses an id that would reach outside its own directory', async () => {
    const problems: string[] = []
    const store = await archive([], problems)

    for (const id of ['../escape', 'a/b', '..', 'term 1', '']) {
      store.put(id, 'anything')
      expect(store.read(id), id).toBeUndefined()
    }
    await store.flush()

    expect(await readdir(store.directory).catch(() => [])).toEqual([])
    expect(problems).toHaveLength(10)
  })

  it('drops a pane record when the pane is dropped', async () => {
    const store = await archive()
    store.put('term_1', 'output\r\n')
    await store.flush()
    expect(await readdir(store.directory)).toEqual(['term_1.json'])

    store.remove('term_1')
    await store.flush()
    expect(await readdir(store.directory)).toEqual([])
    expect(store.read('term_1')).toBeUndefined()
  })

  it('sweeps records no pane points at any more, and keeps the ones that do', async () => {
    const store = await archive()
    store.put('term_kept', 'still open\r\n')
    store.put('term_orphan', 'closed while the app was not running\r\n')
    await store.flush()

    const swept = await ScrollbackArchive.open(store.directory, ['term_kept'])
    expect(await readdir(store.directory)).toEqual(['term_kept.json'])
    expect(swept.read('term_kept')?.text).toBe('still open\r\n')
  })

  // The store refuses to write over a workspace file it could not read, because
  // the panes that file lists are coming back on some later launch. Sweeping
  // their records in the meantime would be this directory deciding otherwise.
  it('sweeps nothing when the caller does not know which panes exist', async () => {
    const store = await archive()
    store.put('term_1', 'output\r\n')
    await store.flush()

    await ScrollbackArchive.open(store.directory, undefined)
    expect(await readdir(store.directory)).toEqual(['term_1.json'])
  })

  it('leaves a directory that is not there alone until something is written', async () => {
    const store = await archive(['term_1'])
    expect(await readdir(store.directory).catch(() => 'missing')).toBe('missing')

    store.put('term_1', 'output\r\n')
    await store.flush()
    expect(await readdir(store.directory)).toEqual(['term_1.json'])
  })
})
