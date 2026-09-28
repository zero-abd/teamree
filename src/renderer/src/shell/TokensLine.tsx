// The open worktree's tokens in the status bar, read while it shows; its subtree's in the hover.

import { usageDetail, usageLabel, usageLines } from '@shared/usage'
import { useUsageReads, useUsageStore } from '../state/usageStore'

export function TokensLine({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  useUsageReads({ worktreeId })
  const usage = useUsageStore((state) => state.usage[worktreeId])
  const showCost = useUsageStore((state) => state.showCost)
  const lines = usageLines(usage, showCost)
  if (usage === undefined || lines === null) return null
  return (
    <span className="statusbar__item statusbar__tokens" title={[usageDetail(usage), ...lines.slice(1)].join('\n')}>
      {usageLabel(usage, showCost) ?? '0 tok'}
    </span>
  )
}
