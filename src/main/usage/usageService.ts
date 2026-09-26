// Tokens per worktree, read from Claude Code's and Codex's own stores for its checkout. Read-only.
// A transcript belongs to the worktree whose path holds its cwd most closely.

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind, Worktree } from '../../shared/entities'
import type { UsageTotals, WorktreeUsage } from '../../shared/tasks'
import { descendantsOf } from '../../shared/taskTree'
import {
  claudeProjectSlug,
  claudeStoreRoot,
  codexSessionsDirectory,
  resolved,
  rolloutFiles
} from '../terminals/agent-conversations'
import { readAppended } from './appendedLines'
import { claudeTokens, claudeTranscript, hasTokens, readClaudeLine, type ClaudeTranscript } from './claudeUsage'
import { codexRollout, readCodexLine, rolloutCwd, type CodexRollout } from './codexUsage'
import { addTokens, costOf, type ModelTokens } from './prices'

/** Newest rollouts looked at per read; older ones are almost never a live worktree's. */
export const MAX_ROLLOUTS = 5000

/** How deep under a project folder transcripts sit (`<session>/subagents/agent-*.jsonl`). */
const CLAUDE_DEPTH = 3

const READ_AGENTS: ReadonlySet<AgentKind> = new Set(['claude', 'codex'])

export type UsageServiceOptions = {
  worktrees: () => readonly Worktree[]
  terminals: () => readonly { worktreeId: string; agent?: AgentKind }[]
  /** Where the agents' stores are when `CLAUDE_CONFIG_DIR` / `CODEX_HOME` do not say. A test seam. */
  home?: string
  now?: () => number
}

export type UsageQuery = { worktreeId?: string; projectId?: string }

type Own = { byModel: ModelTokens; sessions: number }

export class UsageService {
  readonly #options: UsageServiceOptions
  readonly #claude = new Map<string, ClaudeTranscript>()
  readonly #codex = new Map<string, CodexRollout>()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: UsageServiceOptions) {
    this.#options = options
  }

  /** One read at a time, so two callers never read the same bytes twice. */
  usage(query: UsageQuery): Promise<WorktreeUsage[]> {
    const run = this.#queue.then(() => this.#read(query))
    this.#queue = run.catch(() => {})
    return run
  }

  async #read(query: UsageQuery): Promise<WorktreeUsage[]> {
    const all = this.#options.worktrees()
    const wanted = all.filter(
      (worktree) =>
        (query.worktreeId === undefined || worktree.id === query.worktreeId) &&
        (query.projectId === undefined || worktree.projectId === query.projectId)
    )
    const counted = new Map<string, Worktree>()
    for (const worktree of wanted) {
      for (const each of [worktree, ...descendantsOf(all, worktree.id)]) counted.set(each.id, each)
    }
    const owner = ownerOf(all)
    const own = new Map<string, Own>([...counted.keys()].map((id) => [id, { byModel: new Map(), sessions: 0 }]))
    const tallyOf = (cwd: string | null | undefined): Own | undefined =>
      typeof cwd === 'string' ? own.get(owner(cwd) ?? '') : undefined
    const home = this.#options.home ?? os.homedir()

    const transcripts = await this.#claudeTranscripts([...counted.values()], home)
    const byWorktree = new Map<Own, ClaudeTranscript[]>()
    for (const [file, transcript] of transcripts) {
      const tally = tallyOf(transcript.cwd)
      if (tally === undefined) continue
      byWorktree.set(tally, [...(byWorktree.get(tally) ?? []), transcript])
      if (hasTokens(transcript) && !file.includes(`${path.sep}subagents${path.sep}`)) tally.sessions += 1
    }
    for (const [tally, list] of byWorktree) {
      for (const [model, tokens] of claudeTokens(list)) addTokens(tally.byModel, model, tokens)
    }

    let examined = 0
    for (const file of rolloutFiles(codexSessionsDirectory(home))) {
      if (++examined > MAX_ROLLOUTS) break
      let rollout = this.#codex.get(file)
      if (rollout === undefined) {
        rollout = codexRollout()
        rollout.cwd = await rolloutCwd(file)
        // A rollout so new its first line is not written yet is looked at again next time.
        if (rollout.cwd !== null) this.#codex.set(file, rollout)
      }
      const tally = tallyOf(rollout.cwd)
      if (tally === undefined) continue
      const state = rollout
      const outcome = await readAppended(file, state.mark, (line) => readCodexLine(state, line))
      if (outcome === 'restarted') {
        const again = codexRollout()
        again.cwd = state.cwd
        await readAppended(file, again.mark, (line) => readCodexLine(again, line))
        this.#codex.set(file, again)
        rollout = again
      }
      if (rollout.byModel.size === 0) continue
      tally.sessions += 1
      for (const [model, tokens] of rollout.byModel) addTokens(tally.byModel, model, tokens)
    }

    const readAt = (this.#options.now ?? Date.now)()
    const terminals = this.#options.terminals()
    const totals = new Map([...own].map(([id, tally]) => [id, totalsOf(tally)]))
    return wanted.map((worktree) => {
      const children = descendantsOf(all, worktree.id)
      const self = totals.get(worktree.id) ?? totalsOf({ byModel: new Map(), sessions: 0 })
      return {
        worktreeId: worktree.id,
        ...self,
        unknownPanes: terminals.filter(
          (terminal) =>
            terminal.worktreeId === worktree.id && terminal.agent !== undefined && !READ_AGENTS.has(terminal.agent)
        ).length,
        readAt,
        ...(children.length === 0
          ? {}
          : { subtree: sumTotals([self, ...children.map((child) => totals.get(child.id)).filter(isTotals)]) })
      }
    })
  }

  /** Every transcript under the project folders these checkouts' slugs start, read up to date. */
  async #claudeTranscripts(worktrees: readonly Worktree[], home: string): Promise<Map<string, ClaudeTranscript>> {
    const found = new Map<string, ClaudeTranscript>()
    if (worktrees.length === 0) return found
    const projects = path.join(claudeStoreRoot(home), 'projects')
    const folders = await readdir(projects).catch(() => [] as string[])
    // A cwd below the checkout gets its own slug that starts with the checkout's.
    const slugs = worktrees.map((worktree) => claudeProjectSlug(resolved(worktree.path)))
    const matching = folders.filter((folder) => slugs.some((slug) => folder === slug || folder.startsWith(`${slug}-`)))
    for (const folder of matching) {
      for (const file of await jsonlFiles(path.join(projects, folder), CLAUDE_DEPTH)) {
        let transcript = this.#claude.get(file) ?? claudeTranscript()
        const state = transcript
        if ((await readAppended(file, state.mark, (line) => readClaudeLine(state, line))) === 'restarted') {
          transcript = claudeTranscript()
          const again = transcript
          await readAppended(file, again.mark, (line) => readClaudeLine(again, line))
        }
        this.#claude.set(file, transcript)
        found.set(file, transcript)
      }
    }
    return found
  }
}

/** The worktree whose checkout holds `cwd` most closely, or null. */
function ownerOf(worktrees: readonly Worktree[]): (cwd: string) => string | null {
  const checkouts = worktrees
    .filter((worktree) => worktree.path.length > 0)
    .map((worktree) => ({ id: worktree.id, path: resolved(worktree.path) }))
    .sort((a, b) => b.path.length - a.path.length)
  const seen = new Map<string, string | null>()
  return (cwd) => {
    const known = seen.get(cwd)
    if (known !== undefined) return known
    const at = resolved(cwd)
    const id = checkouts.find((checkout) => at === checkout.path || at.startsWith(`${checkout.path}${path.sep}`))?.id
    seen.set(cwd, id ?? null)
    return id ?? null
  }
}

async function jsonlFiles(directory: string, depth: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[])
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full)
    else if (entry.isDirectory() && depth > 1) files.push(...(await jsonlFiles(full, depth - 1)))
  }
  return files
}

function totalsOf({ byModel, sessions }: Own): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: costOf(byModel), sessions }
  for (const tokens of byModel.values()) {
    totals.input += tokens.input
    totals.output += tokens.output
    totals.cacheRead += tokens.cacheRead
    totals.cacheWrite += tokens.cacheWrite
  }
  return totals
}

function sumTotals(list: readonly UsageTotals[]): UsageTotals {
  return list.reduce((sum, each) => ({
    input: sum.input + each.input,
    output: sum.output + each.output,
    cacheRead: sum.cacheRead + each.cacheRead,
    cacheWrite: sum.cacheWrite + each.cacheWrite,
    costUsd: sum.costUsd === null || each.costUsd === null ? null : sum.costUsd + each.costUsd,
    sessions: sum.sessions + each.sessions
  }))
}

function isTotals(value: UsageTotals | undefined): value is UsageTotals {
  return value !== undefined
}
