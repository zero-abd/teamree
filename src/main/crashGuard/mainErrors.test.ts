import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendErrorLog, createMainErrors, LOG_BURST, NOTICE_GAP_MS, type MainErrorsHost } from './mainErrors'

let dir: string
let clock: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamree-main-errors-'))
  clock = 1_000_000
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function errors(overrides: Partial<MainErrorsHost> = {}) {
  const offerRestart = vi.fn<(details: string) => void>()
  const host: MainErrorsHost = {
    logFile: () => join(dir, 'logs', 'main-errors.log'),
    version: '1.2.3',
    now: () => clock,
    offerRestart,
    ...overrides
  }
  return { errors: createMainErrors(host), offerRestart, log: () => readFileSync(host.logFile(), 'utf8') }
}

describe('the error log', () => {
  it('appends the time, the version, the kind and the stack, creating the folder', () => {
    const { errors: guard, log } = errors()
    guard.caught('uncaught exception', new Error('boom'))
    const text = log()
    expect(text).toContain(new Date(clock).toISOString())
    expect(text).toContain('teamree 1.2.3 uncaught exception')
    expect(text).toContain('Error: boom')
    expect(text).toContain('mainErrors.test.ts')
  })

  it('keeps one older file once the log passes its cap', () => {
    const file = join(dir, 'main-errors.log')
    writeFileSync(file, 'x'.repeat(900))
    appendErrorLog(file, 'y'.repeat(200), 1000)
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(900))
    expect(readFileSync(file, 'utf8')).toBe('y'.repeat(200))
    appendErrorLog(file, 'z'.repeat(900), 1000)
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(200))
    expect(statSync(file).size).toBe(900)
  })

  it('never throws when the log cannot be written', () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    expect(appendErrorLog(join(blocker, 'logs', 'main-errors.log'), 'entry')).toBe(false)
    const { errors: guard } = errors({ logFile: () => join(blocker, 'logs', 'main-errors.log') })
    expect(() => guard.caught('uncaught exception', new Error('boom'))).not.toThrow()
  })

  it('logs a burst in full and then only counts, until the minute is over', () => {
    const { errors: guard, log } = errors()
    for (let index = 0; index < LOG_BURST + 5; index += 1) guard.caught('unhandled rejection', new Error(`e${index}`))
    expect(log()).toContain(`e${LOG_BURST - 1}`)
    expect(log()).not.toContain(`e${LOG_BURST}\n`)
    clock += 60_000
    guard.caught('unhandled rejection', new Error('later'))
    expect(log()).toContain('5 more not logged')
    expect(log()).toContain('later')
  })

  it('writes a rejection that is not an Error', () => {
    const { errors: guard, log } = errors()
    guard.caught('unhandled rejection', { code: 42 })
    expect(log()).toContain('{"code":42}')
  })
})

describe('a non-fatal error', () => {
  it('tells the window at most once a minute', () => {
    const { errors: guard, offerRestart } = errors()
    const notify = vi.fn<(details: string) => void>()
    guard.attach(notify)
    guard.caught('uncaught exception', new Error('first'))
    guard.caught('uncaught exception', new Error('second'))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toContain('first')
    clock += NOTICE_GAP_MS
    guard.caught('uncaught exception', new Error('third'))
    expect(notify).toHaveBeenCalledTimes(2)
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('reaches a window that arrives after it', () => {
    const { errors: guard } = errors()
    guard.caught('unhandled rejection', new Error('early'))
    const notify = vi.fn<(details: string) => void>()
    guard.attach(notify)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toContain('early')
  })

  it('is only logged once the app is leaving', () => {
    const { errors: guard, log } = errors()
    const notify = vi.fn<(details: string) => void>()
    guard.attach(notify)
    guard.leaving()
    guard.caught('uncaught exception', new Error('late'))
    expect(notify).not.toHaveBeenCalled()
    expect(log()).toContain('late')
  })
})

describe('a launch that failed', () => {
  it('offers the one restart question, with the details, once', () => {
    const { errors: guard, offerRestart, log } = errors()
    const notify = vi.fn<(details: string) => void>()
    guard.attach(notify)
    guard.launchFailed(new Error('no runtime'))
    guard.launchFailed(new Error('again'))
    guard.caught('uncaught exception', new Error('after'))
    expect(offerRestart).toHaveBeenCalledTimes(1)
    expect(offerRestart.mock.calls[0]?.[0]).toContain('no runtime')
    expect(notify).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'logs', 'main-errors.log'))).toBe(true)
    expect(log()).toContain('after')
  })
})
