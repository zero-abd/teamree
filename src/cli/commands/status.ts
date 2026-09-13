import type { CommandSpec } from '../command-spec.js'
import { formatFields } from '../output.js'

function formatUptime(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export const statusCommands: readonly CommandSpec[] = [
  {
    path: ['status'],
    summary: 'Show the running runtime: version, pid, endpoint.',
    details: 'Fails with exit code 3 when no runtime is reachable, so it doubles as a liveness probe.',
    examples: ['teamree status --json'],
    run: async (context) => {
      const status = await context.client.call('status.get', {})
      return {
        data: { ...status, endpointSource: context.endpointSource },
        text: formatFields([
          ['version', status.version],
          ['pid', String(status.pid)],
          ['platform', status.platform],
          ['endpoint', status.endpoint],
          ['discovered via', context.endpointSource],
          ['started', new Date(status.startedAt).toISOString()],
          ['uptime', formatUptime(status.startedAt, Date.now())]
        ])
      }
    }
  }
]
