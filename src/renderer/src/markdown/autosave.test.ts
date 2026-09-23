import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_DELAY_MS, createAutosave } from './autosave'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createAutosave', () => {
  it('writes once, the last text, half a second after the typing stops', async () => {
    const save = vi.fn(() => Promise.resolve())
    const autosave = createAutosave({ save })
    autosave.change('a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    autosave.change('ab')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(save).not.toHaveBeenCalled()
    expect(autosave.pending()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('ab')
    expect(autosave.pending()).toBe(false)
  })

  it('flushes now rather than waiting, and cancels without writing', async () => {
    const save = vi.fn(() => Promise.resolve())
    const autosave = createAutosave({ save })
    autosave.change('now')
    await autosave.flush()
    expect(save).toHaveBeenCalledWith('now')
    autosave.change('never')
    autosave.cancel()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(save).toHaveBeenCalledTimes(1)
    expect(autosave.pending()).toBe(false)
  })

  it('never runs two writes at once, and writes what was typed during one after it', async () => {
    let finish: () => void = () => {}
    const save = vi.fn(
      (text: string) =>
        new Promise<void>((resolve) => {
          if (text === 'slow') finish = resolve
          else resolve()
        })
    )
    const autosave = createAutosave({ save, delayMs: 10 })
    autosave.change('slow')
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenCalledTimes(1)
    autosave.change('typed meanwhile')
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenCalledTimes(1)
    expect(autosave.pending()).toBe(true)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenLastCalledWith('typed meanwhile')
    expect(save).toHaveBeenCalledTimes(2)
  })
})
