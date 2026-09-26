// The seam behind `project.context`. The ledger is the one built-in source and
// always answers; an out-of-process provider would sit in front of it, cut by a timeout.

import type { MemoryEvent } from '../../shared/contextProvider'
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
  /** Hears each ledger change, so a memory kept elsewhere can mirror it. */
  observe?(projectId: string, event: MemoryEvent): void
}

/** The first provider to answer in time wins; the built-in answers otherwise, with no timeout. */
export async function askSources(
  providers: readonly ContextSource[],
  builtIn: ContextSource,
  query: ContextQuery,
  timeoutMs: number
): Promise<ProjectContext> {
  const reports: ContextSourceReport[] = []
  for (const provider of providers) {
    const started = Date.now()
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    try {
      const answer = await Promise.race([
        provider.context(query, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        })
      ])
      reports.push({ name: provider.name, ms: Date.now() - started })
      return { ...answer, sources: reports }
    } catch (error) {
      controller.abort()
      const message = error instanceof Error ? error.message : String(error)
      reports.push({ name: provider.name, ms: Date.now() - started, error: message })
    } finally {
      clearTimeout(timer)
    }
  }
  const started = Date.now()
  const answer = await builtIn.context(query, new AbortController().signal)
  return { ...answer, sources: [...reports, { name: builtIn.name, ms: Date.now() - started }] }
}
