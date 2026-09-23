// The owner's record of what teammates typed. The first test is the one that matters: the log must not
// contain the bytes. Everything else is bookkeeping, and bookkeeping can be fixed later.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RemoteWrite } from '../../../shared/entities'
import { createRemoteWriteLog, returnsIn, WRITE_LOG_DIR, WRITE_LOG_FILE } from './writeLog'

async function dataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'teamree-writelog-'))
}

function entry(overrides: Partial<RemoteWrite> = {}): RemoteWrite {
  return {
    at: 1_700_000_000_000,
    handle: 'ana',
    publicKey: 'EA3VNMgROVtL/oUJhTmpENptwwkAWhc1HD2SIqJTHE4=',
    projectId: 'p_1',
    terminalId: 't_1',
    bytes: 12,
    returns: 1,
    outcome: 'written',
    ...overrides
  }
}

describe('what the record holds', () => {
  it('holds who, when and which pane, and never what was typed', async () => {
    const dir = await dataDir()
    const log = createRemoteWriteLog({ dataDir: dir })
    // Input includes what a program deliberately does not echo. The shape of it is recorded; the thing
    // itself is not passed to this module at all.
    log.record(entry({ bytes: 'hunter2\r'.length, returns: 1 }))
    await log.flush()

    const raw = await readFile(join(dir, WRITE_LOG_DIR, WRITE_LOG_FILE), 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(JSON.parse(raw.trim()) as RemoteWrite).toMatchObject({
      handle: 'ana',
      terminalId: 't_1',
      bytes: 8,
      returns: 1,
      outcome: 'written'
    })
  })

  it('counts submissions, so a command is not read as a keypress', () => {
    expect(returnsIn('ls')).toBe(0)
    expect(returnsIn('ls\r')).toBe(1)
    expect(returnsIn('ls\nwho\n')).toBe(2)
  })

  it('keeps every refusal, because somebody typing at a muted pane is the point', async () => {
    const dir = await dataDir()
    const log = createRemoteWriteLog({ dataDir: dir })
    log.record(entry({ outcome: 'muted', reason: 'the owner has muted this pane' }))
    log.record(entry({ outcome: 'no-pane', reason: 'that pane’s process has exited' }))
    const read = await log.read()

    expect(read.writes.map((write) => write.outcome)).toEqual(['muted', 'no-pane'])
    expect(read.writes[0]?.reason).toBe('the owner has muted this pane')
    expect(read.problem).toBeNull()
  })
})

describe('keeping the record straight', () => {
  it('keeps writes in the order they happened, however fast they arrive', async () => {
    const dir = await dataDir()
    const log = createRemoteWriteLog({ dataDir: dir })
    // Recorded without awaiting, as the transport files them: two appends must never be in flight together.
    for (let index = 0; index < 50; index += 1) log.record(entry({ at: index }))
    const read = await log.read()
    expect(read.writes.map((write) => write.at)).toEqual([...Array(50).keys()])
  })

  it('survives a restart, because a record that lived in memory would not be one', async () => {
    const dir = await dataDir()
    const first = createRemoteWriteLog({ dataDir: dir })
    first.record(entry({ at: 1 }))
    await first.flush()

    const second = createRemoteWriteLog({ dataDir: dir })
    second.record(entry({ at: 2 }))
    const read = await second.read()
    expect(read.writes.map((write) => write.at)).toEqual([1, 2])
  })

  it('returns the newest entries when asked for a few', async () => {
    const dir = await dataDir()
    const log = createRemoteWriteLog({ dataDir: dir })
    for (let index = 0; index < 10; index += 1) log.record(entry({ at: index }))
    const read = await log.read(3)
    expect(read.writes.map((write) => write.at)).toEqual([7, 8, 9])
  })

  it('rotates once at its cap rather than growing until a disk is full', async () => {
    const dir = await dataDir()
    // Small enough that a handful of entries crosses it.
    const log = createRemoteWriteLog({ dataDir: dir, maxBytes: 400 })
    for (let index = 0; index < 20; index += 1) {
      log.record(entry({ at: index }))
      await log.flush()
    }

    const read = await log.read()
    // A generation back is still readable, and the newest entry is still there.
    expect(read.writes[read.writes.length - 1]?.at).toBe(19)
    expect(read.writes.length).toBeLessThan(20)
    expect(read.writes.length).toBeGreaterThan(1)
  })

  it('counts a line it cannot read rather than inventing one', async () => {
    const dir = await dataDir()
    const log = createRemoteWriteLog({ dataDir: dir })
    log.record(entry({ at: 1 }))
    await log.flush()
    // The ordinary way this happens is a crash mid-append.
    await writeFile(join(dir, WRITE_LOG_DIR, WRITE_LOG_FILE), `{"at":1,"handle":"ana"\n`, { flag: 'a' })

    const read = await log.read()
    expect(read.writes).toHaveLength(1)
    // An invented entry in an audit trail is worse than a missing one, because it would be believed.
    expect(read.problem).toBe('1 entry could not be read')
  })

  it('says so rather than going quiet when it cannot reach the disk', async () => {
    const failures: unknown[] = []
    // A path whose parent is a file, so every write fails the way a full or read-only disk does.
    const dir = await dataDir()
    const blocked = join(dir, 'not-a-directory')
    await writeFile(blocked, 'in the way', 'utf8')

    const log = createRemoteWriteLog({ dataDir: blocked, onError: (error) => failures.push(error) })
    log.record(entry())
    const read = await log.read()

    expect(failures).toHaveLength(1)
    expect(read.problem).toContain('the remote write log could not be written')
  })
})
