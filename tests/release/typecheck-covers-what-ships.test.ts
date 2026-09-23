// Which files the release's type-checking gates actually read. worker.ts once passed every gate with a
// type error (the relay build excludes it; its own typecheck was not a gate), and `tests/` was in no
// tsconfig. This walks `GATES` into package.json scripts, collects each tsconfig handed to tsc, and asks
// the compiler which files each project contains; no `include` list is read.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
// Plain ESM run before any build.
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { GATES } from '../../scripts/release.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Gate = { name: string; args: string[]; cwd?: string }

/** The `scripts` block of one package.json, by the directory holding it. */
function scriptsIn(root: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
}

/** The tsconfigs one npm script hands to tsc, following `npm run` (root `typecheck` is two deep). */
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
    // `npm test` runs no compiler; every gate that could is `npm run <script>`.
    if (gate.args[0] !== 'run') continue
    const root = gate.cwd ? join(REPO_ROOT, gate.cwd) : REPO_ROOT
    for (const project of projectsOf(gate.args[1] as string, scriptsIn(root))) projects.push(join(root, project))
  }
  return projects
}

/** The files one tsconfig's program contains, per `tsc --listFilesOnly`; excludes and references included. */
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

/** Every `.ts` file under `tests/`, as an absolute path. */
function everyTestFile(): string[] {
  return readdirSync(join(REPO_ROOT, 'tests'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => realpathSync(join(REPO_ROOT, 'tests', entry)))
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
  // Guards the walk: a regex that stopped matching would let everything pass against an empty set.
  it('is found by following the gates into the scripts they run', () => {
    const named = projects.map((project) => project.slice(REPO_ROOT.length + 1))
    expect(named).toContain('tsconfig.node.json')
    expect(named).toContain('tsconfig.web.json')
    for (const project of projects) expect(existsSync(project), project).toBe(true)
  })

  it('includes the Cloudflare Worker that gets deployed out of the installed app', () => {
    expect(seenByTheRelease.has(WORKER)).toBe(true)
  })

  // The relay's Node build cannot read this file, which is why the Worker needs its own gate.
  it('reaches the Worker through the relay typecheck and not through the relay build', () => {
    const relayBuild = programFiles(join(REPO_ROOT, 'relay', 'tsconfig.json'))
    expect(relayBuild.has(WORKER)).toBe(false)
    const workerProject = programFiles(join(REPO_ROOT, 'relay', 'tsconfig.workers.json'))
    expect(workerProject.has(WORKER)).toBe(true)
  })

  it('includes every test file, gates-can-fail.test.ts included', () => {
    const files = everyTestFile()
    // A count, so an emptied `tests/` cannot pass the loop below.
    expect(files.length).toBeGreaterThan(20)
    const unseen = files.filter((file) => !seenByTheRelease.has(file)).map((file) => file.slice(REPO_ROOT.length + 1))
    expect(unseen, 'a type error in these would pass `npm run typecheck`').toEqual([])
  })
})
