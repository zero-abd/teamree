// One line of recent output for each pane the sidebar shows. The policy lives in ./evidenceReads;
// this is only the wiring: a timer, a call, and the line picker.

import { useEffect, useRef, useState } from 'react'
import type { Terminal } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { EVIDENCE_TAIL_BYTES, forgetClosed, terminalsToRead, type EvidenceRead } from './evidenceReads'
import { evidenceLine } from '@shared/outputEvidence'

/** How often the policy is consulted; shorter than the per-pane interval so a new pane is read promptly. */
const TICK_MS = 500

export function usePaneEvidence(
  visible: readonly Terminal[],
  terminals: Record<string, Terminal>
): Record<string, string | null> {
  const [evidence, setEvidence] = useState<Record<string, string | null>>({})
  const reads = useRef<Record<string, EvidenceRead>>({})

  // Started once and reads whatever is on screen when it fires, so a pane appearing never restarts the schedule.
  const onScreen = useRef(visible)
  onScreen.current = visible

  useEffect(() => {
    let stopped = false

    const readOne = async (terminal: Terminal): Promise<void> => {
      // Marked before the call, not after: a slow read must not be issued twice.
      reads.current[terminal.id] = { readAt: Date.now(), wasRunning: terminal.running }
      try {
        const { data } = await runtimeClient.call('terminal.read', {
          terminalId: terminal.id,
          tailBytes: EVIDENCE_TAIL_BYTES
        })
        if (stopped) return
        const line = evidenceLine(data)
        setEvidence((current) => (current[terminal.id] === line ? current : { ...current, [terminal.id]: line }))
      } catch {
        // A pane can close between the tick and the read; nothing shown is the same as nothing to show.
      }
    }

    const tick = (): void => {
      const due = new Set(terminalsToRead({ visible: onScreen.current, reads: reads.current, now: Date.now() }))
      for (const terminal of onScreen.current) {
        if (due.has(terminal.id)) void readOne(terminal)
      }
    }

    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    reads.current = forgetClosed(reads.current, terminals)
    setEvidence((current) => forgetClosed(current, terminals))
  }, [terminals])

  return evidence
}
