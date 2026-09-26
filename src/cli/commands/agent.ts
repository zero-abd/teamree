import type { AgentEventName, SubagentEventName } from '../../shared/entities.js'
import { MAX_AGENT_EVENT_DETAIL_CHARS, MAX_AGENT_EVENT_MESSAGE_CHARS, Params } from '../../shared/methods.js'
import type { CommandSpec } from '../command-spec.js'
import { requireString } from '../argv.js'
import { formatTable } from '../output.js'

/** The events the runtime takes, read off the contract rather than restated. */
const PANE_EVENTS: readonly string[] = Params.terminalAgentEvent.shape.event.options
const SUBAGENT_EVENTS: readonly string[] = Params.terminalSubagentEvent.shape.event.options
const EVENT_NAMES: readonly string[] = [...PANE_EVENTS, ...SUBAGENT_EVENTS]

export const agentCommands: readonly CommandSpec[] = [
  {
    path: ['agent', 'list'],
    summary: 'List the coding agents this machine can run.',
    details: 'Probed from PATH rather than configured. Only agents teamree can resume are listed.',
    examples: ['teamree agent list', 'teamree agent list --json'],
    run: async (context) => {
      const agents = await context.client.call('agent.list', {})
      return {
        data: agents,
        text: formatTable(
          ['AGENT', 'COMMAND', 'FOUND AT'],
          agents.map((agent) => [agent.kind, agent.command, agent.binary]),
          'No known coding agents on PATH.'
        )
      }
    }
  },
  {
    path: ['agent', 'event'],
    summary: "Report an agent's hook event to the pane it runs in.",
    details:
      'Run by the agent itself, from a hook teamree configured when it opened the pane: the hook JSON ' +
      'arrives on stdin, the pane and the profile are named on the line. Prints nothing and exits 0 ' +
      'whatever happens, so the agent is never told a hook failed. The sidebar reads the result as ' +
      'the pane state; `terminal list --json` shows it as `agentEvent`.',
    flags: [
      {
        name: 'terminal',
        kind: 'string',
        placeholder: '<id>',
        required: true,
        description: 'The pane the agent runs in.'
      },
      {
        name: 'event',
        kind: 'string',
        placeholder: '<name>',
        required: true,
        choices: EVENT_NAMES,
        description: `The hook event, as the agent names it: ${EVENT_NAMES.join(', ')}.`
      }
    ],
    examples: ['teamree agent event --terminal term_1 --event Notification --user-data-dir "$PROFILE" < hook.json'],
    silent: true,
    run: async (context) => {
      const terminalId = requireString(context.flags, 'terminal')
      const name = requireString(context.flags, 'event')
      const stdin = await context.stdin()
      const at = Date.now()
      // Checked against the contract by `choices`, so these are the casts they look like.
      if (SUBAGENT_EVENTS.includes(name)) {
        const subagent = subagentFields(stdin)
        if (subagent === undefined) return { data: null, text: '' }
        const terminal = await context.client.call('terminal.subagentEvent', {
          terminalId,
          event: name as SubagentEventName,
          at,
          ...subagent
        })
        return { data: terminal, text: '' }
      }
      const event = name as AgentEventName
      const said = { ...eventFields(stdin, event), ...sessionFields(stdin) }
      const terminal = await context.client.call('terminal.agentEvent', { terminalId, event, at, ...said })
      return { data: terminal, text: '' }
    }
  }
]

/**
 * The two fields of the hook's JSON worth carrying: the notification type, which tells a permission
 * prompt from a login, and its message, quoted while the pane asks. Not JSON, or not that shape, is nothing.
 */
export function eventFields(stdin: string, event: AgentEventName): { detail?: string; message?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdin)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const { notification_type: type, message } = parsed as { notification_type?: unknown; message?: unknown }
  return {
    ...(typeof type === 'string' && type.length > 0 ? { detail: type.slice(0, MAX_AGENT_EVENT_DETAIL_CHARS) } : {}),
    ...(event === 'Notification' && typeof message === 'string' && message.trim().length > 0
      ? { message: message.trim().slice(0, MAX_AGENT_EVENT_MESSAGE_CHARS) }
      : {})
  }
}

/** The hook JSON as an object, or undefined for anything else. */
function hookJson(stdin: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdin)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const USABLE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The session the hook ran in and where its transcript is, which find the session's subagents. */
export function sessionFields(stdin: string): { sessionId?: string; transcriptPath?: string } {
  const hook = hookJson(stdin)
  const sessionId = hook?.session_id
  if (typeof sessionId !== 'string' || !USABLE_ID.test(sessionId)) return {}
  const transcriptPath = hook?.transcript_path
  return {
    sessionId,
    ...(typeof transcriptPath === 'string' && transcriptPath.length <= 4096 ? { transcriptPath } : {})
  }
}

/** A subagent hook's ids, or undefined when it carries no usable ones. */
export function subagentFields(
  stdin: string
): { sessionId: string; agentId: string; agentType?: string; transcriptPath?: string } | undefined {
  const hook = hookJson(stdin)
  const session = sessionFields(stdin)
  const agentId = hook?.agent_id
  if (session.sessionId === undefined || typeof agentId !== 'string' || !USABLE_ID.test(agentId)) return undefined
  const agentType = hook?.agent_type
  return {
    ...session,
    sessionId: session.sessionId,
    agentId,
    ...(typeof agentType === 'string' && agentType.length > 0 ? { agentType: agentType.slice(0, 128) } : {})
  }
}
