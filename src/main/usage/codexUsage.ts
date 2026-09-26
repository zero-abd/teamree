// Codex rollouts: `token_count` events carry the session's running total, so each event adds its
// growth over the one before, under the model the latest `turn_context` named.

import { open } from 'node:fs/promises'
import { addTokens, type ModelTokens } from './prices'
import { count, freshMark, objectOf, parsedLine, type FileMark } from './appendedLines'

type Running = { input: number; cached: number; output: number }

export type CodexRollout = {
  mark: FileMark
  /** From `session_meta`; null when the rollout names none. */
  cwd?: string | null
  model: string
  last: Running
  byModel: ModelTokens
}

export function codexRollout(): CodexRollout {
  return { mark: freshMark(), model: '', last: { input: 0, cached: 0, output: 0 }, byModel: new Map() }
}

export function readCodexLine(rollout: CodexRollout, line: string): void {
  if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) return
  const entry = parsedLine(line)
  const payload = objectOf(entry?.payload)
  if (entry === null || payload === null) return
  if (entry.type === 'session_meta' && rollout.cwd === undefined) {
    rollout.cwd = typeof payload.cwd === 'string' ? payload.cwd : null
    return
  }
  if (entry.type === 'turn_context') {
    if (typeof payload.model === 'string') rollout.model = payload.model
    return
  }
  if (entry.type !== 'event_msg' || payload.type !== 'token_count') return
  const total = objectOf(objectOf(payload.info)?.total_token_usage)
  if (total === null) return
  const now: Running = {
    input: count(total.input_tokens),
    cached: count(total.cached_input_tokens),
    output: count(total.output_tokens)
  }
  // A running total that went down started again (a resumed process); what it says now is all new.
  const before =
    now.input < rollout.last.input || now.output < rollout.last.output
      ? { input: 0, cached: 0, output: 0 }
      : rollout.last
  rollout.last = now
  const cached = Math.max(0, now.cached - before.cached)
  // OpenAI's input count includes the cached part.
  const input = Math.max(0, now.input - before.input - cached)
  const output = Math.max(0, now.output - before.output)
  if (input + cached + output === 0) return
  addTokens(rollout.byModel, rollout.model, { input, output, cacheRead: cached, cacheWrite: 0, cacheWrite1h: 0 })
}

/** Enough of a rollout's first line to find its cwd, which sits near the front. */
const HEAD_BYTES = 4096

/** The cwd `session_meta` names, read from the file's head without parsing the rest; null when absent. */
export async function rolloutCwd(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null)
  if (handle === null) return null
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    if (!head.includes('"session_meta"')) return null
    const found = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head)?.[1]
    if (found === undefined) return null
    const cwd: unknown = JSON.parse(found)
    return typeof cwd === 'string' ? cwd : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}
