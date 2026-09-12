import { resolve } from 'node:path'
import type { CommandSpec } from '../command-spec.js'
import { readString } from '../argv.js'
import { formatTable } from '../output.js'
import { resolveProject } from '../selectors.js'

export const projectCommands: readonly CommandSpec[] = [
  {
    path: ['project', 'list'],
    summary: 'List tracked repositories.',
    run: async (context) => {
      const projects = await context.client.call('project.list', {})
      return {
        data: projects,
        text: formatTable(
          ['ID', 'NAME', 'BASE REF', 'PATH'],
          projects.map((project) => [project.id, project.name, project.baseRef, project.path]),
          'No projects tracked. Add one with: teamree project add <path>'
        )
      }
    }
  },
  {
    path: ['project', 'add'],
    summary: 'Track a repository.',
    args: [
      {
        name: 'path',
        description: 'Path to the repository checkout; relative paths resolve from the cwd.',
        required: true
      }
    ],
    flags: [
      {
        name: 'name',
        kind: 'string',
        placeholder: '<name>',
        description: 'Display name; defaults to the directory name.'
      }
    ],
    examples: ['teamree project add ~/repos/api', 'teamree project add . --name api'],
    run: async (context) => {
      const path = resolve(context.cwd, context.args[0] as string)
      const name = readString(context.flags, 'name')
      const project = await context.client.call('project.add', name === undefined ? { path } : { path, name })
      return { data: project, text: `added project ${project.name} (${project.id}) at ${project.path}` }
    }
  },
  {
    path: ['project', 'remove'],
    summary: 'Stop tracking a repository.',
    args: [{ name: 'project', description: 'Project id, name, or path.', required: true }],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      await context.client.call('project.remove', { projectId: project.id })
      return { data: { removed: true, project }, text: `removed project ${project.name} (${project.id})` }
    }
  }
]
