// The one property that cannot be got wrong: a private key that reaches a repository is unrecoverable,
// because a key in a diff is a key everybody has. This suite runs a real join against a real repository
// and then goes looking for the secret in every byte under the checkout, every result, and every log line.

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/entities'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { IDENTITY_FILE_NAME, loadIdentity } from './identity'
import { TeamworkService } from './teamworkService'

const repos: TempRepo[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('the private key never leaves the machine', () => {
  it('is nowhere under the repository after joining it, not even inside .git', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamree-secret-'))
    dirs.push(dataDir)
    const project: Project = { id: 'p', name: 'repo', path: repo.repoPath, baseRef: 'main' }

    // Said out loud is as bad as written down, so the process is bugged for the length of the call.
    const spoken: string[] = []
    const stopListening = captureOutput(spoken)
    let list: unknown
    try {
      const service = new TeamworkService({ store: { getProject: () => project }, dataDir, runner: repo.runner })
      list = await service.joinProject({ projectId: project.id })
    } finally {
      stopListening()
    }

    // Committed too, because a secret that only reached the index is one `git push` from the team.
    await repo.commit('add my key')

    const secrets = await secretShapes(path.join(dataDir, IDENTITY_FILE_NAME))
    const files = await everyFileUnder(repo.repoPath)
    const leaking: string[] = []
    for (const file of files) {
      const contents = await readFile(file, 'utf8').catch(() => '')
      if (secrets.some((secret) => contents.includes(secret))) leaking.push(path.relative(repo.repoPath, file))
    }

    expect(leaking).toEqual([])
    // A search that found nothing because it was searching for nothing would pass for ever.
    expect(files.length).toBeGreaterThan(5)
    expect(secrets).toHaveLength(4)

    for (const secret of secrets) {
      expect(JSON.stringify(list)).not.toContain(secret)
      expect(spoken.join('\n')).not.toContain(secret)
    }
  })

  it('lives outside every repository, in the data directory the app was given', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamree-secret-'))
    dirs.push(dataDir)

    const identity = await loadIdentity(dataDir)

    expect(path.dirname(identity.privateKeyPath)).toBe(dataDir)
    expect((await stat(identity.privateKeyPath)).isFile()).toBe(true)
  })
})

/**
 * Every form the secret could plausibly take on its way out: the file as stored, its base64 body without
 * the PEM furniture, and the raw key bytes in both encodings this codebase would reach for.
 */
async function secretShapes(privateKeyPath: string): Promise<string[]> {
  const pem = await readFile(privateKeyPath, 'utf8')
  const body = pem
    .split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .join('')
  const der = Buffer.from(body, 'base64')
  const scalar = der.subarray(der.length - 32)
  return [pem.trim(), body, scalar.toString('base64'), scalar.toString('hex')]
}

async function everyFileUnder(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) found.push(full)
    }
  }
  await walk(root)
  return found
}

/** Catches everything a call might print, however it chose to print it. */
function captureOutput(sink: string[]): () => void {
  const originalConsole = { ...console }
  const originalStdout = process.stdout.write.bind(process.stdout)
  const originalStderr = process.stderr.write.bind(process.stderr)

  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    console[level] = (...args: unknown[]): void => {
      sink.push(args.map((arg) => String(arg)).join(' '))
    }
  }
  const swallow = (chunk: unknown): boolean => {
    sink.push(String(chunk))
    return true
  }
  process.stdout.write = swallow as typeof process.stdout.write
  process.stderr.write = swallow as typeof process.stderr.write

  return () => {
    Object.assign(console, originalConsole)
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
}
