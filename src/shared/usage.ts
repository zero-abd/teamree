// Tokens as one short phrase, the same on the board, a row's hover, the Changes tab and the CLI.

import type { UsageTotals, WorktreeUsage } from './tasks'

/** Every token the agents were billed for, cache reads and writes included. */
export function totalTokens(usage: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

const UNITS: readonly [number, string][] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k']
]

/** `950`, `1.2k`, `12k`, `1.2M`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  for (let at = UNITS.length - 1; at >= 0; at -= 1) {
    const [size, unit] = UNITS[at] as [number, string]
    const value = tokens / size
    if (Math.round(value * 10) / 10 < 10) return `${value.toFixed(1)}${unit}`
    if (Math.round(value) < 1000 || at === 0) return `${Math.round(value)}${unit}`
  }
  return String(tokens)
}

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`
  return `$${usd.toFixed(2)}`
}

/** `1.2M tok`, `1.2M tok · ≈$3.10` with Show Cost, `≥` when some panes were not read; null with nothing to say. */
export function usageLabel(
  usage: UsageTotals & Partial<Pick<WorktreeUsage, 'unknownPanes'>>,
  showCost: boolean
): string | null {
  const unknown = (usage.unknownPanes ?? 0) > 0
  if (usage.sessions === 0) return unknown ? '? tok' : null
  const tokens = `${unknown ? '≥' : ''}${formatTokens(totalTokens(usage))} tok`
  return showCost && usage.costUsd !== null ? `${tokens} · ≈${formatCost(usage.costUsd)}` : tokens
}

/** `in 13 · out 12 · cache read 1.0k · cache write 600`, for a hover. */
export function usageDetail(usage: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): string {
  return [
    `in ${formatTokens(usage.input)}`,
    `out ${formatTokens(usage.output)}`,
    `cache read ${formatTokens(usage.cacheRead)}`,
    `cache write ${formatTokens(usage.cacheWrite)}`
  ].join(' · ')
}

/** A worktree's own line, then its subtree's when it has children; null with nothing to say. */
export function usageLines(usage: WorktreeUsage | undefined, showCost: boolean): string[] | null {
  if (usage === undefined) return null
  const own = usageLabel(usage, showCost)
  const subtree = usage.subtree === undefined ? null : usageLabel(usage.subtree, showCost)
  if (own === null && subtree === null) return null
  return [own ?? '0 tok', ...(subtree === null ? [] : [`${subtree} with children`])]
}
