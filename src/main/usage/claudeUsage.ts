// Claude Code's transcripts: `message.usage` on each assistant line. A reply streams as several lines
// under one message id, and a resumed session copies earlier replies, so tokens are kept per id.

import { addTokens, isEmpty, type ModelTokens, type Tokens } from './prices'
import { count, freshMark, objectOf, parsedLine, type FileMark } from './appendedLines'

export type ClaudeTranscript = {
  mark: FileMark
  /** The directory the conversation was had in; undefined until a line names it. */
  cwd?: string
  replies: Map<string, { model: string; tokens: Tokens }>
  /** Replies with no id to deduplicate by. */
  loose: ModelTokens
}

export function claudeTranscript(): ClaudeTranscript {
  return { mark: freshMark(), replies: new Map(), loose: new Map() }
}

export function readClaudeLine(transcript: ClaudeTranscript, line: string): void {
  // Most lines are tool output; only these two are worth parsing.
  const wanted = line.includes('"usage"') || (transcript.cwd === undefined && line.includes('"cwd"'))
  if (!wanted) return
  const entry = parsedLine(line)
  if (entry === null) return
  if (transcript.cwd === undefined && typeof entry.cwd === 'string') transcript.cwd = entry.cwd
  if (entry.type !== 'assistant') return
  const message = objectOf(entry.message)
  const usage = objectOf(message?.usage)
  if (message === null || usage === null) return
  const written = objectOf(usage.cache_creation)
  const tokens: Tokens = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite1h: count(written?.ephemeral_1h_input_tokens)
  }
  if (isEmpty(tokens)) return
  const model = typeof message.model === 'string' ? message.model : ''
  const id = typeof message.id === 'string' ? message.id : typeof entry.requestId === 'string' ? entry.requestId : null
  if (id === null) {
    addTokens(transcript.loose, model, tokens)
    return
  }
  const held = transcript.replies.get(id)
  transcript.replies.set(id, { model, tokens: held === undefined ? tokens : larger(held.tokens, tokens) })
}

/** Later lines of one reply carry the final counts; the larger of each is kept. */
function larger(a: Tokens, b: Tokens): Tokens {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h)
  }
}

/** Every reply across these transcripts once, by model. */
export function claudeTokens(transcripts: readonly ClaudeTranscript[]): ModelTokens {
  const replies = new Map<string, { model: string; tokens: Tokens }>()
  const byModel: ModelTokens = new Map()
  for (const transcript of transcripts) {
    for (const [id, reply] of transcript.replies) {
      const held = replies.get(id)
      replies.set(id, held === undefined ? reply : { model: reply.model, tokens: larger(held.tokens, reply.tokens) })
    }
    for (const [model, tokens] of transcript.loose) addTokens(byModel, model, tokens)
  }
  for (const { model, tokens } of replies.values()) addTokens(byModel, model, tokens)
  return byModel
}

export function hasTokens(transcript: ClaudeTranscript): boolean {
  return transcript.replies.size > 0 || transcript.loose.size > 0
}
