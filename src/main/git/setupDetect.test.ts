import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRun, checkSetup, detectRun, detectSetup } from './setupDetect'

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

describe('detectRun', () => {
  const scripts = { dev: 'vite', start: 'node server.js', test: 'vitest run' }

  it.each([
    [['package.json', 'package-lock.json'], { dev: 'npm run dev', test: 'npm test' }],
    [['package.json', 'pnpm-lock.yaml'], { dev: 'pnpm dev', test: 'pnpm test' }],
    [['package.json', 'yarn.lock'], { dev: 'yarn dev', test: 'yarn test' }],
    [['package.json', 'bun.lock'], { dev: 'bun run dev', test: 'bun run test' }]
  ])('%j runs the scripts with its own runner', (files, run) => {
    expect(detectRun(new Set(files), { scripts })).toEqual(run)
  })

  it('falls back to start for dev, and skips the placeholder test npm init writes', () => {
    const placeholder = 'echo "Error: no test specified" && exit 1'
    expect(detectRun(new Set(['package.json']), { scripts: { start: 'node .', test: placeholder } })).toEqual({
      dev: 'npm start'
    })
  })

  it.each([
    [
      ['Makefile'],
      { makefile: 'dev:\n\tgo run .\ntest: build\n\tgo test ./...\n' },
      { dev: 'make dev', test: 'make test' }
    ],
    [['Makefile'], { makefile: 'TEST := 1\nrun:\n\t./app\n' }, { dev: 'make run' }],
    [['Cargo.toml', 'Cargo.lock'], {}, { test: 'cargo test' }],
    [['go.mod', 'go.sum'], {}, { test: 'go test ./...' }],
    [['pyproject.toml', 'uv.lock'], {}, { test: 'uv run pytest' }],
    [['README.md'], {}, {}]
  ])('%j with %j runs %j', (files, contents, run) => {
    expect(detectRun(new Set(files), contents)).toEqual(run)
  })

  it('prefers package.json scripts, then the Makefile, per kind', () => {
    const names = new Set(['package.json', 'Makefile', 'go.mod'])
    expect(detectRun(names, { scripts: { dev: 'vite' }, makefile: 'test:\n\tnpm test\n' })).toEqual({
      dev: 'npm run dev',
      test: 'make test'
    })
  })
})

describe('checkRun', () => {
  it('reads the scripts and Makefile off the checkout', async () => {
    const dir = await checkout(['pnpm-lock.yaml'])
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node dev.js' } }))
    await writeFile(path.join(dir, 'Makefile'), 'test:\n\tnode test.js\n')
    expect(await checkRun(dir)).toEqual({ dev: 'pnpm dev', test: 'make test' })
  })

  it('answers empty for a package.json it cannot parse, or a checkout it cannot read', async () => {
    const dir = await checkout([])
    await writeFile(path.join(dir, 'package.json'), '{ not json')
    expect(await checkRun(dir)).toEqual({})
    expect(await checkRun(path.join(os.tmpdir(), 'teamree-no-such-checkout'))).toEqual({})
  })
})
