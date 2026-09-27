// The seam behind `project.context`. The ledger is the one built-in source and always answers;
// an out-of-process provider adds to it when it answers in time and valid, and is left out otherwise.

import type { MemoryEvent, ProviderContext } from '../../shared/contextProvider'
import type { GraphAnswer, GraphAsk, RelatedTask } from '../../shared/graphMemory'
import type { ContextSection, ContextSourceReport, ProjectContext } from '../../shared/memory'

export type ContextQuery = {
  projectId: string
  worktreeId: string
  budgetTokens: number
  sections?: ContextSection[]
  query?: string
}

export interface ContextSource {
  readonly name: string
  context(query: ContextQuery, signal: AbortSignal): Promise<ProjectContext>
}

/** Memory kept out of process: it hears each ledger change and adds to the bundle it is asked for. */
export interface ContextProvider {
  readonly name: string
  context(query: ContextQuery): Promise<ProviderContext>
  observe?(projectId: string, event: MemoryEvent): void
  ask?(projectId: string, ask: GraphAsk, timeoutMs?: number): Promise<GraphAnswer>
}

/** Earlier tasks told in the bundle, at most. */
const RELATED_SHOWN = 2

/** The built-in bundle, with what each provider answered in time added; a slow or broken one is only reported. */
export async function askSources(
  providers: readonly ContextProvider[],
  builtIn: ContextSource,
  query: ContextQuery,
  timeoutMs: number
): Promise<ProjectContext> {
  const asked = providers.map(async (provider) => {
    const started = Date.now()
    let timer: NodeJS.Timeout | undefined
    try {
      const extra = await Promise.race([
        provider.context(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        })
      ])
      return { report: { name: provider.name, ms: Date.now() - started }, extra }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { report: { name: provider.name, ms: Date.now() - started, error: message } }
    } finally {
      clearTimeout(timer)
    }
  })
  const started = Date.now()
  let answer = await builtIn.context(query, new AbortController().signal)
  const own: ContextSourceReport = { name: builtIn.name, ms: Date.now() - started }
  const answers = await Promise.all(asked)
  for (const { extra } of answers) if (extra !== undefined) answer = mergeProviderContext(answer, extra, query)
  return { ...answer, sources: [...answers.map((row) => row.report), own] }
}

/** Adds a provider's earlier tasks below the ledger's lines, within the budget; the ledger's own sections stand. */
export function mergeProviderContext(
  base: ProjectContext,
  extra: ProviderContext,
  query: Pick<ContextQuery, 'budgetTokens' | 'sections'>
): ProjectContext {
  const related = (extra.related ?? []).slice(0, RELATED_SHOWN)
  if (related.length === 0 || (query.sections !== undefined && !query.sections.includes('related'))) return base
  const lines = base.text === '' ? [] : [base.text]
  let used = base.text.length
  const kept: RelatedTask[] = []
  let dropped = 0
  for (const task of related) {
    const line = relatedLine(task)
    const cost = line.length + (lines.length > 0 ? 1 : 0)
    if (Math.ceil((used + cost) / 4) > query.budgetTokens) {
      dropped += 1
      continue
    }
    used += cost
    lines.push(line)
    kept.push(task)
  }
  const text = lines.join('\n')
  return {
    ...base,
    ...(kept.length > 0 ? { related: kept } : {}),
    text,
    tokens: Math.ceil(text.length / 4),
    truncated: dropped === 0 ? base.truncated : [...base.truncated, { section: 'related', dropped }]
  }
}

/** One line: which task, how it ended, the files it shares and its first decision or reason. */
export function relatedLine(task: RelatedTask): string {
  const label = task.pr > 0 ? `#${task.pr} ${task.name}` : task.name
  const why = task.decisions[0] ?? task.goal
  const files = task.files.length > 0 ? ` [${task.files.join(', ')}]` : ''
  return `earlier: ${label} (${task.outcome})${files}: ${why}`
}
