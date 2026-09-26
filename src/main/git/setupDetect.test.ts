import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSetup, detectSetup } from './setupDetect'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function checkout(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'teamree-setup-'))
  dirs.push(dir)
  for (const file of files) {
    if (file.endsWith('/')) await mkdir(path.join(dir, file), { recursive: true })
    else await writeFile(path.join(dir, file), '')
  }
  return dir
}

describe('detectSetup', () => {
  it.each([
    [['package.json', 'package-lock.json'], 'npm ci', 'node_modules'],
    [['package.json', 'pnpm-lock.yaml'], 'pnpm install --frozen-lockfile', 'node_modules'],
    [['package.json', 'yarn.lock'], 'yarn install --immutable', 'node_modules'],
    [['package.json', 'bun.lockb'], 'bun install', 'node_modules'],
    [['package.json', 'bun.lock'], 'bun install', 'node_modules'],
    [['package.json'], 'npm install', 'node_modules'],
    [['pyproject.toml', 'uv.lock'], 'uv sync', '.venv'],
    [['Gemfile', 'Gemfile.lock'], 'bundle install', undefined]
  ])('%j suggests %s', (files, command, installs) => {
    expect(detectSetup(new Set(files))).toEqual(installs === undefined ? { command } : { command, installs })
  })

  it.each([[['go.mod', 'go.sum']], [['README.md']], [[]]])('%j suggests nothing', (files) => {
    expect(detectSetup(new Set(files))).toBeUndefined()
  })

  it('prefers a lockfile over a bare package.json, and JavaScript over the rest', () => {
    expect(detectSetup(new Set(['package.json', 'pnpm-lock.yaml', 'package-lock.json']))?.command).toBe(
      'pnpm install --frozen-lockfile'
    )
    expect(detectSetup(new Set(['package.json', 'package-lock.json', 'uv.lock']))?.command).toBe('npm ci')
  })
})

describe('checkSetup', () => {
  it('names the directory the command would create when the checkout lacks it', async () => {
    const dir = await checkout(['package.json', 'package-lock.json'])
    expect(await checkSetup(dir)).toEqual({ command: 'npm ci', missing: 'node_modules' })
  })

  it('says nothing is missing once it is there', async () => {
    const dir = await checkout(['package.json', 'package-lock.json', 'node_modules/'])
    expect(await checkSetup(dir)).toEqual({ command: 'npm ci' })
  })

  it('answers empty for a checkout it cannot read or recognise', async () => {
    expect(await checkSetup(await checkout(['go.mod']))).toEqual({})
    expect(await checkSetup(path.join(os.tmpdir(), 'teamree-no-such-checkout'))).toEqual({})
  })
})
