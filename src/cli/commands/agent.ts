import type { AgentEventName } from '../../shared/entities.js'
import { MAX_AGENT_EVENT_DETAIL_CHARS, Params } from '../../shared/methods.js'
import type { CommandSpec } from '../command-spec.js'
import { requireString } from '../argv.js'
import { formatTable } from '../output.js'

/** The events the runtime takes, read off the contract rather than restated. */
const EVENT_NAMES: readonly string[] = Params.terminalAgentEvent.shape.event.options

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
      // Checked against the contract by `choices`, so this is the cast it looks like.
      const event = requireString(context.flags, 'event') as AgentEventName
      const detail = eventDetail(await context.stdin())
      const terminal = await context.client.call('terminal.agentEvent', {
        terminalId,
        event,
        at: Date.now(),
        ...(detail === undefined ? {} : { detail })
      })
      return { data: terminal, text: '' }
    }
  }
]

/**
 * The one field of the hook's JSON worth carrying: the notification type,
 * which is what tells a permission prompt from a login. Anything else on
 * stdin — the message, the prompt, the transcript path — is the agent's and
 * is not copied. Not JSON, or not that shape, is simply no detail.
 */
export function eventDetail(stdin: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdin)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const type = (parsed as { notification_type?: unknown }).notification_type
  if (typeof type !== 'string' || type.length === 0) return undefined
  return type.slice(0, MAX_AGENT_EVENT_DETAIL_CHARS)
}
