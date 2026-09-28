// A pane's lifecycle as the pane draws it: the starting shimmer, the asking card and the state footer while
// an agent runs, and the end block (marker line and one row of actions) once the program is gone.

import { useEffect, useState } from 'react'
import type { Terminal } from '@shared/entities'
import { markerTime } from '@shared/paneMarker'
import type { StoppedFor } from '@shared/paneRestore'
import { runState } from '@shared/runCommands'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { Modal } from '../dialogs/Modal'
import { Icon } from '../icons/Icon'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { activityOf, askingLine } from '../sidebar/agentRows'
import { SCREEN_ROWS_READ, screenEvidence } from '../sidebar/paneScreen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { shownScreen } from '../terminal/shownPanes'
import { Button, type ButtonVariant } from '../ui/Button'
import { StatusDot, type PaneState } from '../ui/StatusPill'
import { missingTool, type MissingTool } from './missingTool'

/** What a shell's ^C exit reads as: the person stopped it, nothing failed. */
const INTERRUPTED = 130
/** A shell's exit when the program it was asked to run is not on PATH. */
const NOT_FOUND = 127

/** The stage `terminal` is in; null for a live shell, which draws none. `seen`: it has printed. */
export function paneStage(terminal: Terminal, seen: boolean): PaneState | null {
  if (!terminal.running) {
    // One that failed before the quit came back failed, with its exit code.
    if (terminal.restored === 'stopped' && terminal.stoppedFor !== 'failed') return 'restored'
    if (terminal.run !== undefined && runState(terminal) === 'stopped') return 'ended'
    const code = terminal.exitCode
    return code === undefined || code === 0 || code === INTERRUPTED ? 'ended' : 'failed'
  }
  if ((terminal.agent ?? terminal.foregroundAgent) === undefined) return null
  if (!seen) return 'starting'
  const activity = activityOf(terminal)
  if (activity === 'waiting') return 'asking'
  return activity === 'working' ? 'working' : 'ready'
}

/** Whether the pane has printed, from anything that says so; it latches, a pane never un-prints. */
export function useSeenOutput(terminal: Terminal | undefined): boolean {
  const said =
    terminal === undefined ||
    terminal.busy ||
    terminal.agentEvent !== undefined ||
    terminal.tookTurn === true ||
    terminal.restored !== undefined ||
    terminal.foregroundAgent !== undefined
  const [seen, setSeen] = useState(said)
  const id = terminal?.id
  useEffect(() => {
    if (seen || said || id === undefined) return
    const look = (): void => {
      if (shownScreen(id)?.rows.some((row) => row.trim() !== '')) setSeen(true)
    }
    look()
    const timer = setInterval(look, 250)
    return () => clearInterval(timer)
  }, [seen, said, id])
  return seen || said
}

/** The agent's glyph and a shimmer line, top-left, until the first byte. */
export function PaneStarting({ terminal }: { terminal: Terminal }): React.JSX.Element {
  const agent = terminal.agent ?? terminal.foregroundAgent
  return (
    <div className="pane-starting" aria-hidden="true">
      {agent === undefined ? null : <AgentGlyph kind={agent} decorative />}
      <span className="shimmer-line" />
    </div>
  )
}

/** The pane's latest line, read off its own emulator while it is drawn. */
function useShownLine(terminal: Terminal, live: boolean): string | null {
  const [line, setLine] = useState<string | null>(null)
  const { id, agent, foregroundAgent } = terminal
  useEffect(() => {
    if (!live) return
    const read = (): void => {
      const screen = shownScreen(id, SCREEN_ROWS_READ)
      const next = screen === null ? null : screenEvidence(screen, { agent, foregroundAgent })
      setLine((current) => (current === next ? current : next))
    }
    read()
    const timer = setInterval(read, 1_000)
    return () => clearInterval(timer)
  }, [id, agent, foregroundAgent, live])
  return line
}

/** When each pane entered its stage; outside the component, so showing another worktree does not reset it. */
const stageSince = new Map<string, { stage: PaneState; at: number }>()

/** Milliseconds since the pane's stage last changed, ticking each second while `ticking`. */
function useStageAge(terminalId: string, stage: PaneState, ticking: boolean): number {
  let since = stageSince.get(terminalId)
  if (since?.stage !== stage) {
    since = { stage, at: Date.now() }
    stageSince.set(terminalId, since)
  }
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])
  return Math.max(0, now - since.at)
}

/** `18s`, `4m`, `2h`: how long the agent has been at it. */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

const FOOT_WORD: Record<'starting' | 'working' | 'asking' | 'ready', string> = {
  starting: 'Starting',
  working: 'Working',
  asking: 'Asking',
  ready: 'Ready'
}

/**
 * A live agent's state in one slim line under its output. Always there while the agent runs, whatever
 * the state, so a state change never refits the terminal and makes the agent redraw.
 */
export function PaneFoot({
  terminal,
  stage
}: {
  terminal: Terminal
  stage: 'starting' | 'working' | 'asking' | 'ready'
}): React.JSX.Element {
  const line = useShownLine(terminal, stage !== 'starting')
  const age = useStageAge(terminal.id, stage, stage === 'working')
  const said = stage === 'asking' ? askFor(terminal, line) : line
  const parts = [FOOT_WORD[stage], said, stage === 'working' ? elapsedLabel(age) : null].filter(
    (part): part is string => part !== null && part !== ''
  )
  return (
    <div className={`pane-foot pane-foot--${stage}`}>
      {stage === 'ready' ? (
        <Icon name="check" size={14} className="pane-foot__check" />
      ) : (
        <span className={`pane-foot__dot${stage === 'working' ? ' pane-foot__dot--breathing' : ''}`}>
          <StatusDot state={stage} />
        </span>
      )}
      <span className="pane-foot__text">{parts.join(' · ')}</span>
      {stage === 'working' ? (
        <Button
          variant="ghost"
          size="sm"
          className="pane-foot__stop"
          onClick={() => void runtimeClient.call('terminal.write', { terminalId: terminal.id, data: '\u001b' })}
        >
          Stop
        </Button>
      ) : null}
    </div>
  )
}

/** The question an asking pane is sitting on: its screen's, else its hook's words. */
function askFor(terminal: Terminal, line: string | null): string | null {
  return askingLine(line, terminal.agentEvent)
}

/** Over the top of an asking pane: what it wants, and the way to answer. Floats, so nothing refits. */
export function PaneAsk({ terminal, onReview }: { terminal: Terminal; onReview: () => void }): React.JSX.Element {
  const answerPane = useWorkspaceStore((state) => state.answerPane)
  const line = useShownLine(terminal, true)
  const permission = terminal.screenMenu !== undefined || terminal.agentEvent?.event === 'Notification'
  const title = permission ? 'Permission needed' : 'Needs you'
  const ask = askFor(terminal, line)
  const allow = terminal.screenMenu?.choices[0]
  return (
    <div className="pane-state pane-state--asking" role="group" aria-label={title}>
      <span className="pane-state__dot">
        <StatusDot state="asking" />
      </span>
      <span className="pane-state__body">
        <span className="pane-state__title">{title}</span>
        {ask === null ? null : (
          <span className="pane-state__meta" title={ask}>
            {ask}
          </span>
        )}
      </span>
      <span className="pane-state__actions">
        {allow === undefined ? null : (
          <Button variant="primary" size="sm" title={allow.label} onClick={() => void answerPane(terminal.id, allow)}>
            Allow
          </Button>
        )}
        <Button variant={allow === undefined ? 'primary' : 'ghost'} size="sm" onClick={onReview}>
          Review
        </Button>
      </span>
    </div>
  )
}

export type EndActions = {
  /** Its program again: an agent's conversation, a Run pane's command, or a new shell. */
  onRelaunch: (options?: { fresh?: boolean }) => void
  onResumeConversation?: () => void
  onClose: () => void
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
}

type EndAction = { label: string; run: () => void; tone: ButtonVariant }

const STOPPED_WORDS: Record<StoppedFor, string> = {
  'task-done': 'Task done',
  'no-conversation': 'Nothing to resume',
  failed: 'Failed'
}

/** The end block's marker words: how it ended and when. */
export function endMarker(
  terminal: Terminal,
  stage: 'ended' | 'failed' | 'restored',
  missing: MissingTool | null = null
): string {
  const time = terminal.lastOutputAt > 0 ? markerTime(terminal.lastOutputAt) : null
  if (stage === 'restored') {
    const why = terminal.stoppedFor === undefined ? 'Restored' : STOPPED_WORDS[terminal.stoppedFor]
    return time === null ? why : `${why} · ${time}`
  }
  if (stage === 'failed') {
    const head = missing === null ? `Exited ${terminal.exitCode ?? ''}`.trim() : `${missing.tool} not found`
    return [head, time].filter(Boolean).join(' · ')
  }
  const stopped = terminal.run !== undefined && runState(terminal) === 'stopped'
  const head = [stopped ? 'Stopped' : 'Ended', time].filter(Boolean).join(' ')
  return terminal.exitCode === INTERRUPTED ? `${head} · ^C` : head
}

/** Whether the end block's first action starts its agent afresh rather than resuming or rerunning. */
export function primaryIsFresh(terminal: Terminal, stage: 'ended' | 'failed' | 'restored'): boolean {
  const agent = terminal.agent !== undefined && terminal.run === undefined
  return stage === 'restored' || (agent && terminal.resumable !== true)
}

function endActions(
  terminal: Terminal,
  stage: 'ended' | 'failed' | 'restored',
  actions: EndActions,
  showLog: () => void
): EndAction[] {
  const close: EndAction = { label: 'Close', run: actions.onClose, tone: 'ghost' }
  const log: EndAction = { label: 'Show Log', run: showLog, tone: 'secondary' }
  const again = (label: string, fresh = false): EndAction => ({
    label,
    run: () => actions.onRelaunch(fresh ? { fresh: true } : undefined),
    tone: 'secondary'
  })
  const primary = (action: EndAction): EndAction => ({ ...action, tone: 'primary' })
  const agent = terminal.agent !== undefined && terminal.run === undefined
  // Resume only where there is a conversation to pick up: anything else starts afresh and says so.
  if (stage === 'restored') {
    const pick = actions.onResumeConversation
    const others: EndAction[] =
      pick === undefined || terminal.stoppedFor === 'task-done'
        ? []
        : [{ label: 'Resume…', run: pick, tone: 'secondary' }]
    return [primary(again('New Session', true)), ...others, close]
  }
  if (agent) {
    const fresh = again(stage === 'failed' ? 'Run Again' : 'New Session', true)
    const rest = stage === 'failed' ? [log, close] : [close]
    return terminal.resumable === true ? [primary(again('Resume')), fresh, ...rest] : [primary(fresh), ...rest]
  }
  const rerun = primary(again(terminal.run === undefined ? 'New Shell' : 'Run Again'))
  return stage === 'failed' ? [rerun, log, close] : [rerun, close]
}

/** Under an ended, failed or restored pane's output: a marker line and one row of actions, the first primary. */
export function PaneEndBlock({
  terminal,
  name,
  stage,
  actions
}: {
  terminal: Terminal
  name: string
  stage: 'ended' | 'failed' | 'restored'
  actions: EndActions
}): React.JSX.Element {
  const [log, setLog] = useState(false)
  const missing = useMissingAfterExit(terminal, stage === 'failed' && terminal.exitCode === NOT_FOUND)
  const agent = terminal.agent !== undefined && terminal.run === undefined
  const label = agent ? `${harnessName(terminal.agent!)} ${stage}` : `${name} ${stage}`
  return (
    <div
      className={`pane-end pane-end--${stage}`}
      role="group"
      aria-label={label}
      onContextMenu={actions.onContextMenu}
    >
      <div className="pane-marker">{endMarker(terminal, stage, missing)}</div>
      {missing?.fix === undefined ? null : (
        <p className="pane-end__hint">
          Install with: <code>{missing.fix}</code>
        </p>
      )}
      <div className="pane-end__row">
        {endActions(terminal, stage, actions, () => setLog(true)).map((action) => (
          <Button key={action.label} variant={action.tone} size="sm" onClick={action.run}>
            {action.label}
          </Button>
        ))}
      </div>
      {log ? <PaneLog terminal={terminal} name={name} onClose={() => setLog(false)} /> : null}
    </div>
  )
}

/** How much of a pane's output is read for the program it could not find. */
const NOT_FOUND_TAIL_BYTES = 4 * 1024

/** The program a pane that exited 127 could not find, read off its last output once. */
function useMissingAfterExit(terminal: Terminal, notFound: boolean): MissingTool | null {
  const [missing, setMissing] = useState<MissingTool | null>(null)
  const id = terminal.id
  useEffect(() => {
    setMissing(null)
    if (!notFound) return
    let live = true
    void runtimeClient
      .call('terminal.read', { terminalId: id, tailBytes: NOT_FOUND_TAIL_BYTES })
      .then((read) => live && setMissing(missingTool(plainText(read.data).split('\n'))))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [id, notFound])
  return missing
}

/** Rows the setup pane's check reads: the error and the prompt after it. */
const SETUP_ROWS_READ = 3

/** Over the setup pane, which stays a shell: the program its command could not find, while the screen says so. */
export function SetupMissingTool({ terminal }: { terminal: Terminal }): React.JSX.Element | null {
  const [missing, setMissing] = useState<MissingTool | null>(null)
  const id = terminal.id
  useEffect(() => {
    const read = (): void => {
      const rows = (shownScreen(id, SCREEN_ROWS_READ)?.rows ?? []).filter((row) => row.trim() !== '')
      const next = missingTool(rows.slice(-SETUP_ROWS_READ))
      setMissing((current) => (current?.tool === next?.tool ? current : next))
    }
    read()
    const timer = setInterval(read, 1_000)
    return () => clearInterval(timer)
  }, [id])
  if (missing === null) return null
  const title = `${missing.tool} not found`
  return (
    <div className="pane-state pane-state--failed" role="group" aria-label={title}>
      <span className="pane-state__dot">
        <StatusDot state="failed" />
      </span>
      <span className="pane-state__body">
        <span className="pane-state__title">{title}</span>
        {missing.fix === undefined ? null : (
          <span className="pane-state__meta">
            Install with: <code>{missing.fix}</code>
          </span>
        )}
      </span>
    </div>
  )
}

/** Escape sequences and carriage-return overwrites dropped, for reading as plain text. */
function plainText(output: string): string {
  return output
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?:]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()#][0-9A-Za-z]|\u001b[=>78c]/g, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').split('\r').at(-1) ?? '')
    .join('\n')
}

/** How much of a dead pane's output the log sheet reads. */
const LOG_TAIL_BYTES = 256 * 1024

/** The pane's output as plain text in a sheet, for reading and copying what scrolled away. */
function PaneLog({
  terminal,
  name,
  onClose
}: {
  terminal: Terminal
  name: string
  onClose: () => void
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const copy = useWorkspaceStore((state) => state.copyToClipboard)
  useEffect(() => {
    let live = true
    void runtimeClient
      .call('terminal.read', { terminalId: terminal.id, tailBytes: LOG_TAIL_BYTES })
      .then((read) => live && setText(plainText(read.data).trimEnd()))
      .catch(() => live && setText(''))
    return () => {
      live = false
    }
  }, [terminal.id])
  const code = terminal.exitCode === undefined ? '' : ` · exit ${terminal.exitCode}`
  return (
    <Modal title={`${name}${code}`} onClose={onClose}>
      <pre className="pane-log">{text ?? ''}</pre>
      <div className="modal__actions">
        <Button disabled={!text} onClick={() => void copy(text ?? '', `the output of ${name}`)}>
          Copy
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  )
}
