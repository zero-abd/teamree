// What everything this app spawned costs: an icon on the rail, with the memory beside it past 2 GB or while
// open, and per-pane CPU and memory in the panel with a Kill per row. Sampled slowly while closed, every 2s open.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResourceProcess, SystemResources } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import {
  APP_ROW,
  formatBytes,
  formatCpu,
  groupByWorktree,
  recordSample,
  SPARKLINE_SAMPLES,
  type ResourceHistory
} from './resourceSamples'
import { StatusPopover } from './StatusPopover'

export const OPEN_INTERVAL_MS = 2_000
export const CLOSED_INTERVAL_MS = 10_000
/** Below this the rail shows the icon alone: a number that is always there stops being read. */
const RAIL_MEMORY_BYTES = 2 * 1024 * 1024 * 1024
/** How long a `Kill` stays armed before it goes back to being a `Kill`. */
const CONFIRM_MS = 4_000

export function ResourcesControl(): React.JSX.Element {
  const ready = useWorkspaceStore((state) => state.connection.phase === 'ready')
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const [open, setOpen] = useState(false)
  const [sample, setSample] = useState<SystemResources | null>(null)
  const [history, setHistory] = useState<ResourceHistory>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [armed, setArmed] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await runtimeClient.call('system.resources', {})
      setSample(next)
      setHistory((previous) => recordSample(previous, next))
      setProblem(null)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    void refresh()
    const timer = setInterval(() => void refresh(), open ? OPEN_INTERVAL_MS : CLOSED_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [open, ready, refresh])

  useEffect(
    () => () => {
      if (disarm.current !== null) clearTimeout(disarm.current)
    },
    []
  )

  const close = useCallback(() => {
    setOpen(false)
    setArmed(null)
    button.current?.focus()
  }, [])

  const toggle = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Two presses: the first arms the row, which disarms if left alone.
  const kill = async (pid: number): Promise<void> => {
    if (disarm.current !== null) clearTimeout(disarm.current)
    if (armed !== pid) {
      setArmed(pid)
      disarm.current = setTimeout(() => setArmed(null), CONFIRM_MS)
      return
    }
    setArmed(null)
    try {
      await runtimeClient.call('system.kill', { pid })
      await refresh()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const killButton = (pid: number, label: string): React.JSX.Element => (
    <button
      type="button"
      className={`resources__kill${armed === pid ? ' resources__kill--armed' : ''}`}
      aria-label={label}
      onClick={() => void kill(pid)}
    >
      {armed === pid ? 'Confirm' : 'Kill'}
    </button>
  )

  const processRows = (processes: readonly ResourceProcess[], killable: boolean): React.JSX.Element => (
    <ul className="resources__processes">
      {processes.map((process) => (
        <li key={process.pid} className="resources__process">
          <span className="resources__pid">{process.pid}</span>
          <span className="resources__command">{process.command}</span>
          <span className="resources__cpu">{formatCpu(process.cpu)}</span>
          <span className="resources__rss">{formatBytes(process.rss)}</span>
          {killable ? killButton(process.pid, `Kill ${process.pid}`) : <span className="resources__kill-space" />}
        </li>
      ))}
    </ul>
  )

  const groups = sample ? groupByWorktree(sample, worktrees, terminals) : []
  const railMemory = sample !== null && (open || sample.rss >= RAIL_MEMORY_BYTES) ? formatBytes(sample.rss) : null

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`statusbar__item statusbar__button${open ? ' statusbar__button--on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Resources${sample ? `, ${formatBytes(sample.rss)}` : ''}`}
        title="Resources"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg className="statusbar__icon" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3.5 3.5 H10.5 V10.5 H3.5 Z M5.5 1 V3.5 M8.5 1 V3.5 M5.5 10.5 V13 M8.5 10.5 V13 M1 5.5 H3.5 M1 8.5 H3.5 M10.5 5.5 H13 M10.5 8.5 H13" />
        </svg>
        {railMemory}
      </button>
      {open ? (
        <StatusPopover label="Resources" anchor={button.current} onClose={close}>
          <div className="resources">
            <div className="resources__header">
              <span className="resources__total">
                {sample ? formatCpu(sample.cpu) : '…'}
                <span className="statusbar__muted"> · </span>
                {sample ? formatBytes(sample.rss) : '…'}
              </span>
              <button type="button" className="resources__refresh" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
            {problem ? <div className="resources__problem">{problem}</div> : null}
            <ul className="resources__groups">
              {groups.map((group) => (
                <li key={group.worktreeId} className="resources__group">
                  <div className="resources__worktree">{group.name}</div>
                  <ul className="resources__panes">
                    {group.panes.map(({ pane, name }) => {
                      const shown = expanded.has(pane.terminalId)
                      return (
                        <li key={pane.terminalId} className="resources__pane">
                          <div className="resources__row">
                            <button
                              type="button"
                              className="resources__disclosure"
                              aria-expanded={shown}
                              aria-label={`${shown ? 'Hide' : 'Show'} processes of ${name}`}
                              onClick={() => toggle(pane.terminalId)}
                            >
                              {shown ? '▾' : '▸'}
                            </button>
                            <span className="resources__name">{name}</span>
                            <Sparkline values={history[pane.terminalId] ?? []} />
                            <span className="resources__cpu">{formatCpu(pane.cpu)}</span>
                            <span className="resources__rss">{formatBytes(pane.rss)}</span>
                            {pane.processes.length > 0 ? (
                              killButton(pane.pid, `Kill ${name}`)
                            ) : (
                              <span className="resources__kill-space" />
                            )}
                          </div>
                          {shown ? processRows(pane.processes, true) : null}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
              {sample ? (
                <li className="resources__group resources__group--app">
                  <div className="resources__row">
                    <button
                      type="button"
                      className="resources__disclosure"
                      aria-expanded={expanded.has(APP_ROW)}
                      aria-label={`${expanded.has(APP_ROW) ? 'Hide' : 'Show'} processes of teamree`}
                      onClick={() => toggle(APP_ROW)}
                    >
                      {expanded.has(APP_ROW) ? '▾' : '▸'}
                    </button>
                    <span className="resources__name">teamree</span>
                    <Sparkline values={history[APP_ROW] ?? []} />
                    <span className="resources__cpu">{formatCpu(sample.app.cpu)}</span>
                    <span className="resources__rss">{formatBytes(sample.app.rss)}</span>
                    <span className="resources__kill-space" />
                  </div>
                  {expanded.has(APP_ROW) ? processRows(sample.app.processes, false) : null}
                </li>
              ) : null}
            </ul>
          </div>
        </StatusPopover>
      ) : null}
    </>
  )
}

const SPARK_W = 54
const SPARK_H = 12

/** The last thirty readings as a line, scaled to the row's peak with a floor so idle is flat. */
function Sparkline({ values }: { values: readonly number[] }): React.JSX.Element {
  const peak = Math.max(10, ...values)
  const step = SPARK_W / (SPARKLINE_SAMPLES - 1)
  const offset = SPARKLINE_SAMPLES - values.length
  const points = values
    .map((value, index) => `${((offset + index) * step).toFixed(1)},${(SPARK_H - (value / peak) * SPARK_H).toFixed(1)}`)
    .join(' ')
  return (
    <svg
      className="resources__spark"
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-hidden="true"
    >
      {values.length > 1 ? <polyline points={points} /> : null}
    </svg>
  )
}
