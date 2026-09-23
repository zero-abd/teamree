import type { CommandSpec } from '../command-spec.js'
import { formatTable } from '../output.js'

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
  }
]
