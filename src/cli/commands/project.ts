import { resolve } from 'node:path'
import { cloneDestination, cloneFailureLine, runClone } from '../../main/git/clone.js'
import { createGitRunner } from '../../main/git/gitProcess.js'
import type { Project } from '../../shared/entities.js'
import { checkTransport } from '../../shared/origin.js'
import type { CommandSpec } from '../command-spec.js'
import { readBoolean, readString } from '../argv.js'
import { CliError, ExitCode, UsageError } from '../exit.js'
import { formatTable } from '../output.js'
import { resolveProject } from '../selectors.js'

export const projectCommands: readonly CommandSpec[] = [
  {
    path: ['project', 'list'],
    summary: 'List tracked repositories.',
    run: async (context) => {
      const projects = await context.client.call('project.list', {})
      return {
        data: projects.map(withProjectDefaults),
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
      return {
        data: withProjectDefaults(project),
        text: `added project ${project.name} (${project.id}) at ${project.path}`
      }
    }
  },
  {
    path: ['project', 'clone'],
    summary: 'Clone a repository and track it.',
    details: "Runs git clone with git's own credential helper; nothing is prompted for.",
    args: [
      { name: 'url', description: 'Repository URL or path.', required: true },
      {
        name: 'dir',
        description: 'Where to clone; relative paths resolve from the cwd. Defaults to ~/code/<repo>.',
        required: false
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
    examples: [
      'teamree project clone git@github.com:acme/api.git',
      'teamree project clone https://github.com/acme/api ~/src/api'
    ],
    run: async (context) => {
      const url = (context.args[0] as string).trim()
      const dir = context.args[1]
      const transport = checkTransport(url)
      if (!transport.ok) throw new UsageError(transport.reason)
      let into: string
      try {
        into = cloneDestination(url, dir === undefined ? undefined : resolve(context.cwd, dir))
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error))
      }
      const result = await runClone(createGitRunner(), {
        origin: url,
        into,
        cwd: context.cwd,
        // Progress on stderr, never under --json: a failure document goes there too.
        ...(context.json ? {} : { onProgress: (line: string) => context.streams.err(`${line}\n`) })
      })
      if (!result.ok) {
        throw new CliError({
          code: 'clone_failed',
          message: cloneFailureLine(result.kind, result.stderr),
          exitCode: ExitCode.Failure,
          data: { url, into, kind: result.kind }
        })
      }
      const name = readString(context.flags, 'name')
      const project = await context.client.call(
        'project.add',
        name === undefined ? { path: into } : { path: into, name }
      )
      return {
        data: withProjectDefaults(project),
        text: `cloned ${url} into ${project.path} as ${project.name} (${project.id})`
      }
    }
  },
  pathsCommand('linked', {
    summary: 'Show or set the gitignored directories every new worktree symlinks.',
    details:
      'Given no paths, prints the list. Given paths, replaces it. Each must be a gitignored, untracked ' +
      'directory in the primary checkout; anything else is refused by name when a worktree is prepared. ' +
      'An ignore rule ending in a slash does not match a symlink, so git lists the link as untracked.',
    examples: ['teamree project linked api', 'teamree project linked api node_modules .venv']
  }),
  pathsCommand('copied', {
    summary: 'Show or set the gitignored files every new worktree copies.',
    details:
      'Given no paths, prints the list. Given paths, replaces it. Copies are budgeted: a directory large ' +
      'enough to be worth linking is refused rather than copied.',
    examples: ['teamree project copied api', 'teamree project copied api .env .env.local']
  }),
  {
    path: ['project', 'setup'],
    summary: 'Show or set the command every new worktree runs.',
    details:
      'Given no command, prints the stored one. Given one, replaces it; --clear removes it.\n' +
      'It runs once the checkout is ready, in a pane of the new worktree labelled "setup", in your login ' +
      'shell with the checkout as its cwd — so you watch it and can Ctrl-C it. It is not parsed: quote it ' +
      'as one argument and it is typed into that pane verbatim.\n' +
      'The pane is recorded on the worktree as setupTerminalId, which `worktree list --json` and ' +
      '`worktree wait --json` carry once the checkout is ready.',
    args: [
      { name: 'project', description: 'Project id, name, or path.', required: true },
      { name: 'command', description: 'One shell command. Quote it.', required: false }
    ],
    flags: [{ name: 'clear', kind: 'boolean', description: 'Remove the command.' }],
    examples: ['teamree project setup api', 'teamree project setup api "npm ci"'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const command = context.args[1]
      const clear = readBoolean(context.flags, 'clear')
      // Naming no command reads as a question; removing one has to be typed on purpose.
      const after =
        clear || command !== undefined
          ? await context.client.call('project.setPaths', {
              projectId: project.id,
              setupCommand: clear ? '' : (command as string)
            })
          : project
      return {
        data: withProjectDefaults(after),
        text: after.setupCommand ?? `${after.name} runs nothing in a new worktree`
      }
    }
  },
  {
    path: ['project', 'remove'],
    summary: 'Remove a project from teamree; its folder and worktrees stay on disk.',
    args: [{ name: 'project', description: 'Project id, name, or path.', required: true }],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      await context.client.call('project.remove', { projectId: project.id })
      return {
        data: { removed: true, project: withProjectDefaults(project) },
        text: `removed project ${project.name} (${project.id})`
      }
    }
  }
]

// The two path lists differ only in which field they touch.
function pathsCommand(
  kind: 'linked' | 'copied',
  spec: { summary: string; details: string; examples: readonly string[] }
): CommandSpec {
  return {
    path: ['project', kind],
    summary: spec.summary,
    details: spec.details,
    args: [
      { name: 'project', description: 'Project id, name, or path.', required: true },
      {
        name: 'path',
        description: 'Repository-relative path. Given any, they replace the whole list.',
        required: false,
        variadic: true
      }
    ],
    flags: [{ name: 'clear', kind: 'boolean', description: 'Empty the list.' }],
    examples: spec.examples,
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const paths = context.args.slice(1)
      const clear = readBoolean(context.flags, 'clear')
      // Naming no paths reads as a question, never "make it empty": a shell that
      // expanded a glob to nothing did not mean to.
      const wanted = clear ? [] : paths
      const change = kind === 'linked' ? { linkedPaths: wanted } : { copiedPaths: wanted }
      const after =
        clear || paths.length > 0
          ? await context.client.call('project.setPaths', { projectId: project.id, ...change })
          : project
      return { data: withProjectDefaults(after), text: describePaths(after, kind) }
    }
  }
}

// The store drops empty lists and an empty command (see `GitService.setProjectPaths`),
// so a `--json` caller could not tell an empty list from a field this build lacks.
// The absence is resolved here, at the edge that promises a JSON shape.
function withProjectDefaults(
  project: Project
): Project & { linkedPaths: string[]; copiedPaths: string[]; setupCommand: string } {
  return {
    ...project,
    linkedPaths: project.linkedPaths ?? [],
    copiedPaths: project.copiedPaths ?? [],
    setupCommand: project.setupCommand ?? ''
  }
}

function describePaths(project: Project, kind: 'linked' | 'copied'): string {
  const paths = (kind === 'linked' ? project.linkedPaths : project.copiedPaths) ?? []
  if (paths.length === 0) return `${project.name} ${kind === 'linked' ? 'links' : 'copies'} nothing into new worktrees`
  return paths.join('\n')
}
