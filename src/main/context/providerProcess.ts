// One out-of-process context provider, spoken to in NDJSON over its stdio. Every call is cut at
// its timeout; three failures in a row and the provider stays off until it is started again.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  CONTEXT_PROVIDER_PROTOCOL,
  MAX_PROVIDER_LINE_CHARS,
  PROVIDER_FAILURES_BEFORE_OFF,
  PROVIDER_TIMEOUT_MS,
  parseProviderLine,
  type MemoryEvent,
  type ProviderContext,
  type ProviderReply,
  type ProviderRequest
} from '../../shared/contextProvider'
import type { GraphAnswer, GraphAsk } from '../../shared/graphMemory'
import type { ContextProvider, ContextQuery } from './source'

/** A fresh process compiles its Jac first; a hello slower than this is a failure. */
const START_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 1_000
const STDERR_TAIL_CHARS = 2_000
/** Events queued past this for a stuck process are a failure, not a growing buffer. */
const MAX_UNWRITTEN_BYTES = 8 * 1024 * 1024

export type ProviderState = 'stopped' | 'starting' | 'running' | 'failed'

/** An event for one project, as a (re)started provider is told what the ledger knows. */
export type ProviderEventLine = { projectId: string; event: MemoryEvent }

export type ProviderProcessOptions = {
  name: string
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  app: string
  timeoutMs?: number
  startTimeoutMs?: number
  /** Sent after each hello, so a new process starts from what the ledger knows now. */
  greet?: () => Promise<readonly ProviderEventLine[]>
  onState?: (state: ProviderState) => void
}

type Pending = {
  expects: 'hello' | 'context' | 'answer'
  resolve: (reply: ProviderReply) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class ProviderOff extends Error {}

export class ProviderProcess implements ContextProvider {
  readonly name: string
  readonly #options: ProviderProcessOptions
  #child: ChildProcess | undefined
  #state: ProviderState = 'stopped'
  #failures = 0
  #detail: string | undefined
  #version: string | undefined
  #nextId = 1
  readonly #pending = new Map<number, Pending>()
  #buffer = ''
  #stderr = ''

  constructor(options: ProviderProcessOptions) {
    this.name = options.name
    this.#options = options
  }

  get state(): ProviderState {
    return this.#state
  }

  /** Why it failed, or the last thing it said on stderr. */
  get detail(): string | undefined {
    return this.#detail
  }

  get version(): string | undefined {
    return this.#version
  }

  /** Starts it when stopped or failed, clearing the failures: a person asked for it again. */
  start(): void {
    if (this.#state === 'starting' || this.#state === 'running') return
    this.#failures = 0
    this.#detail = undefined
    this.#launch()
  }

  async stop(): Promise<void> {
    this.#set('stopped')
    await this.#end(new ProviderOff('stopped'))
  }

  observe(projectId: string, event: MemoryEvent): void {
    if (this.#state === 'running') this.#write({ type: 'event', projectId, event })
  }

  async context(query: ContextQuery): Promise<ProviderContext> {
    const reply = await this.#request(
      (id) => ({
        type: 'context',
        id,
        projectId: query.projectId,
        worktreeId: query.worktreeId,
        budgetTokens: query.budgetTokens,
        ...(query.sections === undefined ? {} : { sections: query.sections }),
        ...(query.query === undefined ? {} : { query: query.query })
      }),
      'context'
    )
    return (reply as Extract<ProviderReply, { type: 'context' }>).context
  }

  async ask(projectId: string, ask: GraphAsk, timeoutMs?: number): Promise<GraphAnswer> {
    const reply = await this.#request((id) => ({ type: 'ask', id, projectId, ask }), 'answer', timeoutMs)
    const answer = (reply as Extract<ProviderReply, { type: 'answer' }>).answer
    if (answer.walker !== ask.walker) throw this.#fail(`asked ${ask.walker}, answered ${answer.walker}`)
    return answer
  }

  #launch(): void {
    this.#set('starting')
    this.#buffer = ''
    this.#stderr = ''
    let child: ChildProcess
    try {
      child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
        cwd: this.#options.cwd,
        env: this.#options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      this.#fail(describe(error))
      return
    }
    this.#child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.#read(child, chunk))
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS)
    })
    // A write to a process that just died; its exit is what counts.
    child.stdin?.on('error', () => {})
    child.on('error', (error) => this.#gone(child, describe(error)))
    child.on('exit', (code, signal) => this.#gone(child, `exited ${signal ?? code ?? ''}`.trim()))

    const hello = this.#send(
      () => ({ type: 'hello', protocol: CONTEXT_PROVIDER_PROTOCOL, app: this.#options.app }),
      'hello',
      this.#options.startTimeoutMs ?? START_TIMEOUT_MS
    )
    // A process that never says hello, or speaks another protocol, is not retried.
    const refuse = async (why: string): Promise<void> => {
      if (this.#child !== child) return
      this.#detail = why
      this.#set('failed')
      await this.#end(new ProviderOff(why))
    }
    void hello.then(
      async (reply) => {
        if (reply.type !== 'hello' || reply.protocol !== CONTEXT_PROVIDER_PROTOCOL) {
          await refuse(`speaks protocol ${reply.type === 'hello' ? reply.protocol : '?'}`)
          return
        }
        if (this.#child !== child) return
        this.#version = reply.version
        const lines = (await this.#options.greet?.().catch(() => [])) ?? []
        if (this.#child !== child) return
        for (const line of lines) this.#write({ type: 'event', projectId: line.projectId, event: line.event })
        this.#set('running')
      },
      (error: unknown) => refuse(describe(error))
    )
  }

  async #request(
    build: (id: number) => ProviderRequest,
    expects: 'context' | 'answer',
    timeoutMs?: number
  ): Promise<ProviderReply> {
    if (this.#state === 'stopped' || this.#state === 'failed') throw new ProviderOff(`${this.name} is off`)
    if (this.#state === 'starting') throw new ProviderOff(`${this.name} is starting`)
    return this.#send(build, expects, timeoutMs ?? this.#options.timeoutMs ?? PROVIDER_TIMEOUT_MS)
  }

  #send(
    build: (id: number) => ProviderRequest,
    expects: Pending['expects'],
    timeoutMs: number
  ): Promise<ProviderReply> {
    const id = this.#nextId++
    return new Promise<ProviderReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(this.#fail('timeout'))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { expects, resolve, reject, timer })
      this.#write(build(id))
    })
  }

  #write(message: ProviderRequest): void {
    const stdin = this.#child?.stdin
    if (stdin === undefined || stdin === null || stdin.destroyed) return
    if (stdin.writableLength > MAX_UNWRITTEN_BYTES) {
      this.#fail('not reading its input')
      void this.#end(new ProviderOff('stuck'))
      return
    }
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  #read(child: ChildProcess, chunk: string): void {
    if (this.#child !== child) return
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line !== '') this.#line(line)
      if (this.#child !== child) return
      newline = this.#buffer.indexOf('\n')
    }
    if (this.#buffer.length > MAX_PROVIDER_LINE_CHARS) {
      this.#buffer = ''
      this.#fail('line too long')
      void this.#end(new ProviderOff('line too long'))
    }
  }

  #line(line: string): void {
    const reply = parseProviderLine(line)
    if (reply === undefined) {
      this.#fail('unreadable line')
      return
    }
    // A hello echoes no id; it answers the one hello in flight.
    const id =
      reply.type === 'hello' ? [...this.#pending].find(([, pending]) => pending.expects === 'hello')?.[0] : reply.id
    const pending = id === undefined ? undefined : this.#pending.get(id)
    // An answer to a call already timed out was counted then.
    if (id === undefined || pending === undefined) {
      if (reply.type === 'error' && reply.id === undefined) this.#fail(reply.message)
      return
    }
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (reply.type === 'error') {
      pending.reject(this.#fail(reply.message))
      return
    }
    if (reply.type !== pending.expects) {
      pending.reject(this.#fail(`answered ${reply.type} to ${pending.expects}`))
      return
    }
    // A hello proves the process starts, not that it answers: a crash loop still adds up.
    if (pending.expects !== 'hello') this.#failures = 0
    pending.resolve(reply)
  }

  #gone(child: ChildProcess, why: string): void {
    if (this.#child !== child) return
    this.#child = undefined
    const said = this.#stderr.trim().split('\n').pop()
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(why))
      this.#pending.delete(id)
    }
    if (this.#state === 'stopped' || this.#state === 'failed') return
    this.#fail(said ? `${why}: ${said}` : why)
    if (this.#failures < PROVIDER_FAILURES_BEFORE_OFF) this.#launch()
  }

  /** Counts one failure; the third in a row turns the provider off. */
  #fail(why: string): Error {
    this.#failures += 1
    this.#detail = why
    if (this.#failures >= PROVIDER_FAILURES_BEFORE_OFF && this.#state !== 'failed' && this.#state !== 'stopped') {
      this.#set('failed')
      void this.#end(new ProviderOff(why))
    }
    return new Error(why)
  }

  async #end(error: Error): Promise<void> {
    const child = this.#child
    this.#child = undefined
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.#pending.delete(id)
    }
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stdin?.end()
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
    timer.unref?.()
    await exited
    clearTimeout(timer)
  }

  #set(state: ProviderState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onState?.(state)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
