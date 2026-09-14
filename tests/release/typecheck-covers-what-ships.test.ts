// What the release's type-checking gates actually read, which is a different
// question from whether they can fail.
//
// `gates-can-fail.test.ts` asks the first question and found two gates that
// could not say no. This file asks the second, and the answer was worse in the
// same way: a gate that reads the wrong set of files does not need to be broken
// to be useless.
//
// `relay/src/workers/worker.ts` is the Cloudflare Worker somebody deploys out
// of the installed app. `scripts/verify-package.mjs` proves it is in the
// package, and nothing proved it compiled: the relay's own `build` excludes it
// on purpose, because it is the one file in the project that names Cloudflare
// types and the Node build has none; the relay's `typecheck` does cover it and
// was not in the release sequence; and vitest strips types rather than checking
// them. A type error planted in it passed typecheck, format, lint, the relay
// build, the suite, the app build and the packaging, and would have reached the
// first person to run the deploy command.
//
// So the question this file asks is a coverage question, and it asks it of the
// gates rather than of the tsconfigs: it reads `GATES`, follows each gate into
// the package.json script it runs, collects every tsconfig those scripts hand
// to tsc, and asks the compiler itself which files each of those projects
// contains. Nothing below reads an `include` list. A project that stopped
// covering a file would fail here however it stopped.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
// The release script is plain ESM because it is run by `npm run release` from a
// checkout, before anything has been built.
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { GATES } from '../../scripts/release.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Gate = { name: string; args: string[]; cwd?: string }

/** The `scripts` block of one package.json, by the directory holding it. */
function scriptsIn(root: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
}

/**
 * The tsconfigs one npm script hands to tsc, following `npm run` into others.
 *
 * The root `typecheck` is two scripts deep — it runs `typecheck:node` and
 * `typecheck:web`, and only those name a project — so a reader that stopped at
 * the first level would conclude the release type-checks nothing at all.
 */
function projectsOf(script: string, scripts: Record<string, string>, seen = new Set<string>()): string[] {
  const body = scripts[script]
  if (body === undefined || seen.has(script)) return []
  seen.add(script)

  const projects: string[] = []
  for (const step of body.split('&&').map((part) => part.trim())) {
    const nested = /^npm run ([\w:-]+)$/.exec(step)
    if (nested) {
      projects.push(...projectsOf(nested[1] as string, scripts, seen))
      continue
    }
    const project = /^tsc\b.*?\s-p\s+(\S+)/.exec(step)
    if (project) projects.push(project[1] as string)
  }
  return projects
}

/** Every tsconfig the release sequence puts in front of the compiler, as an absolute path. */
function typecheckedProjects(): string[] {
  const projects: string[] = []
  for (const gate of GATES as Gate[]) {
    // `{ args: ['test'] }` is `npm test`, which runs no compiler; every gate
    // that could is spelled `npm run <script>`.
    if (gate.args[0] !== 'run') continue
    const root = gate.cwd ? join(REPO_ROOT, gate.cwd) : REPO_ROOT
    for (const project of projectsOf(gate.args[1] as string, scriptsIn(root))) projects.push(join(root, project))
  }
  return projects
}

/**
 * The files one tsconfig's program contains, according to tsc.
 *
 * `--listFilesOnly` resolves the program and prints it without checking it,
 * which is the whole of what is being asked here and takes about a second.
 * Asking the compiler rather than reading `include` is the point: an `exclude`,
 * a project reference or a path that resolves somewhere unexpected are all
 * things a glob in a config file does not tell you about.
 */
function programFiles(project: string): Set<string> {
  const result = spawnSync('npx', ['tsc', '-p', project, '--listFilesOnly'], { cwd: REPO_ROOT, encoding: 'utf8' })
  expect(result.status, `tsc could not read ${project}:\n${result.stdout}${result.stderr}`).toBe(0)
  return new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => realpathSync(line))
  )
}

const WORKER = realpathSync(join(REPO_ROOT, 'relay', 'src', 'workers', 'worker.ts'))

let projects: string[] = []
/** The union of every project the release type-checks — what the gate sees, in one set. */
let seenByTheRelease = new Set<string>()

beforeAll(() => {
  projects = typecheckedProjects()
  seenByTheRelease = new Set(projects.flatMap((project) => [...programFiles(project)]))
}, 120_000)

describe('what the release sequence type-checks', () => {
  // Guards the machinery above rather than the coverage below: a regex that
  // stopped matching would make every assertion here pass against an empty set.
  // The two named are the ones the root `typecheck` has always run, so this
  // says the walk works without restating what the walk is supposed to find.
  it('is found by following the gates into the scripts they run', () => {
    const named = projects.map((project) => project.slice(REPO_ROOT.length + 1))
    expect(named).toContain('tsconfig.node.json')
    expect(named).toContain('tsconfig.web.json')
    for (const project of projects) expect(existsSync(project), project).toBe(true)
  })

  it('includes the Cloudflare Worker that gets deployed out of the installed app', () => {
    expect(seenByTheRelease.has(WORKER)).toBe(true)
  })

  // The discovery, kept as a test so the line above is not satisfied by
  // accident. The relay's Node build cannot read this file and is not supposed
  // to, which is exactly why the Worker needed a gate of its own rather than a
  // wider `include` somewhere.
  it('reaches the Worker through the relay typecheck and not through the relay build', () => {
    const relayBuild = programFiles(join(REPO_ROOT, 'relay', 'tsconfig.json'))
    expect(relayBuild.has(WORKER)).toBe(false)
    const workerProject = programFiles(join(REPO_ROOT, 'relay', 'tsconfig.workers.json'))
    expect(workerProject.has(WORKER)).toBe(true)
  })
})
