// A minimal MCP server on stdio for agents without usable hooks (Codex): `siblings` and `note`, plus
// `conflict_risk` and `why_file` while the Jac Graph Memory add-on runs. Newline-delimited JSON-RPC 2.0.

import { createInterface } from 'node:readline'
import { z } from 'zod'
import { MAX_NOTE_CHARS, MAX_NOTE_PATHS } from '../shared/memory.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import type { RuntimeClient } from './transport.js'

/** Newest first; an unknown request is answered with the first. */
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const TOOLS = [
  {
    name: 'siblings',
    description:
      'Sibling worktrees whose changes overlap this one: their goals, shared paths, likely merge conflicts and ' +
      'decisions. With a path, only the siblings changing or claiming that file. Call before editing shared files.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'A file you are about to edit.' } }
    }
  },
  {
    name: 'note',
    description:
      'Record a short decision. Siblings see it when they touch its paths; it expires when this worktree lands.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: MAX_NOTE_CHARS },
        paths: { type: 'array', items: { type: 'string' }, maxItems: MAX_NOTE_PATHS }
      },
      required: ['text']
    }
  }
] as const

/** Listed only while the add-on runs; called anyway, they answer from the ledger. */
const GRAPH_TOOLS = [
  {
    name: 'conflict_risk',
    description:
      'Before editing files: siblings and teammates changing or claiming them, or changing files that usually ' +
      'change together with them in git history. Without paths, the files this worktree touched.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, maxItems: 50 } }
    }
  },
  {
    name: 'why_file',
    description:
      'Why a file is as it is: the merged tasks and commit reasons that changed it, decisions recorded on it ' +
      '(kept after their worktree landed), and who changed it most.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
] as const

const RiskArgs = z.object({ paths: z.array(z.string().min(1).max(4096)).max(50).optional() })
const WhyArgs = z.object({ path: z.string().min(1).max(4096) })

const SiblingsArgs = z.object({ path: z.string().min(1).max(4096).optional() })
const NoteArgs = z.object({
  text: z.string().trim().min(1).max(MAX_NOTE_CHARS),
  paths: z.array(z.string().min(1).max(4096)).max(MAX_NOTE_PATHS).optional()
})

export type McpOptions = { call: RuntimeClient['call']; worktreeId: string; terminalId?: string }

type Request = { id?: string | number | null; method?: unknown; params?: Record<string, unknown> }
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true }

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

/** Serves until `input` ends. Requests are answered in order; notifications never are. */
export async function serveMcp(
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  options: McpOptions
): Promise<void> {
  const send = (message: object): void => write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === '') continue
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    if (request.id === undefined || request.id === null) continue
    try {
      send({ id: request.id, result: await answer(request, options) })
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603
      send({ id: request.id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

async function answer(request: Request, options: McpOptions): Promise<object> {
  switch (request.method) {
    case 'initialize': {
      const asked = request.params?.protocolVersion
      return {
        protocolVersion: typeof asked === 'string' && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'teamree', version: String(PROTOCOL_VERSION) }
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: (await graphRunning(options)) ? [...TOOLS, ...GRAPH_TOOLS] : TOOLS }
    case 'tools/call':
      return callTool(String(request.params?.name), request.params?.arguments ?? {}, options)
    default:
      throw new RpcError(-32601, `Method not found: ${String(request.method)}`)
  }
}

async function graphRunning(options: McpOptions): Promise<boolean> {
  try {
    const addons = await options.call('addons.status', {})
    return addons.some((addon) => addon.id === 'jac-memory' && addon.state === 'running')
  } catch {
    return false
  }
}

async function callGraphTool(name: string, args: unknown, options: McpOptions): Promise<ToolResult> {
  const parsed = name === 'why_file' ? WhyArgs.safeParse(args) : RiskArgs.safeParse(args)
  if (!parsed.success) return toolText(parsed.error.issues.map((issue) => issue.message).join('; '), true)
  try {
    if (name === 'why_file') {
      const { path } = parsed.data as z.infer<typeof WhyArgs>
      const why = await options.call('memory.why', { worktreeId: options.worktreeId, path })
      return toolText(why.text === '' ? 'No history.' : why.text)
    }
    const { paths } = parsed.data as z.infer<typeof RiskArgs>
    const risk = await options.call('memory.risk', {
      worktreeId: options.worktreeId,
      ...(paths === undefined ? {} : { paths })
    })
    return toolText(risk.text === '' ? 'No risk found.' : risk.text)
  } catch (error) {
    return toolText(error instanceof Error ? error.message : String(error), true)
  }
}

function toolText(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true as const } : {}) }
}

async function callTool(name: string, args: unknown, options: McpOptions): Promise<ToolResult> {
  if (name === 'conflict_risk' || name === 'why_file') return callGraphTool(name, args, options)
  if (name !== 'siblings' && name !== 'note') throw new RpcError(-32602, `Unknown tool: ${name}`)
  const parsed = (name === 'siblings' ? SiblingsArgs : NoteArgs).safeParse(args)
  if (!parsed.success) return toolText(parsed.error.issues.map((issue) => issue.message).join('; '), true)
  try {
    if (name === 'note') {
      const { text: body, paths } = parsed.data as z.infer<typeof NoteArgs>
      const note = await options.call('memory.note', {
        worktreeId: options.worktreeId,
        kind: 'decision',
        text: body,
        ...(paths === undefined || paths.length === 0 ? {} : { paths }),
        ...(options.terminalId === undefined ? {} : { terminalId: options.terminalId })
      })
      return toolText(`noted ${note.id}`)
    }
    const { path } = parsed.data as z.infer<typeof SiblingsArgs>
    const found =
      path === undefined
        ? (await options.call('project.context', { worktreeId: options.worktreeId, format: 'text' })).text
        : (await options.call('memory.check', { worktreeId: options.worktreeId, path })).text
    return toolText(found === '' ? 'No overlap.' : found)
  } catch (error) {
    return toolText(error instanceof Error ? error.message : String(error), true)
  }
}
