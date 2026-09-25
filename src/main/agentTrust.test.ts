import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeConfigFile,
  claudeTrusts,
  codexConfigFile,
  codexTrusts,
  rewriteConfig,
  trustNewWorktree,
  withClaudeTrust,
  withCodexTrust
} from './agentTrust'

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A scratch home with a main checkout, a worktree beside it, and each CLI's config dir. */
async function world(): Promise<{
  env: { CLAUDE_CONFIG_DIR: string; CODEX_HOME: string }
  home: string
  main: string
  worktree: string
  claudeFile: string
  codexFile: string
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'teamree-trust-')))
  scratch.push(root)
  const main = path.join(root, 'repo')
  const worktree = path.join(root, 'worktrees', 'repo', 'task')
  await mkdir(main, { recursive: true })
  await mkdir(worktree, { recursive: true })
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') }
  await mkdir(env.CLAUDE_CONFIG_DIR)
  await mkdir(env.CODEX_HOME)
  return {
    env,
    home: path.join(root, 'home'),
    main,
    worktree,
    claudeFile: path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'),
    codexFile: path.join(env.CODEX_HOME, 'config.toml')
  }
}

function claudeConfig(trusted: string[]): string {
  const projects: Record<string, unknown> = { '/elsewhere': { allowedTools: ['Bash(ls)'], lastCost: 0.5 } }
  for (const folder of trusted) projects[folder] = { allowedTools: [], hasTrustDialogAccepted: true }
  return JSON.stringify({ numStartups: 7, theme: 'dark', projects, oauthAccount: { emailAddress: 'a@b.c' } }, null, 2)
}

function codexConfig(trusted: string[]): string {
  return [
    'model = "gpt-5"',
    '# a comment the owner wrote',
    '',
    '[projects."/elsewhere"]',
    'trust_level = "untrusted"',
    ...trusted.flatMap((folder) => ['', `[projects.${JSON.stringify(folder)}]`, 'trust_level = "trusted"']),
    ''
  ].join('\n')
}

describe('where each CLI keeps folder trust', () => {
  it('follows CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const { env, home } = await world()
    expect(await claudeConfigFile(env, home)).toBe(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'))
    expect(codexConfigFile(env, home)).toBe(path.join(env.CODEX_HOME, 'config.toml'))
  })

  it('prefers a legacy .config.json in claude’s config dir', async () => {
    const { env, home } = await world()
    await writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.config.json'), '{}')
    expect(await claudeConfigFile(env, home)).toBe(path.join(env.CLAUDE_CONFIG_DIR, '.config.json'))
  })

  it('resolves the real files under the home folder without the variables, and reads nothing', async () => {
    const home = os.homedir()
    const legacy = path.join(home, '.claude', '.config.json')
    expect(await claudeConfigFile({}, home)).toBe(existsSync(legacy) ? legacy : path.join(home, '.claude.json'))
    expect(codexConfigFile({}, home)).toBe(path.join(home, '.codex', 'config.toml'))
  })
})

describe('reading and adding trust', () => {
  it('reads claude’s per-folder flag and nothing looser', () => {
    const text = claudeConfig(['/repo'])
    expect(claudeTrusts(text, ['/repo'])).toBe(true)
    expect(claudeTrusts(text, ['/elsewhere'])).toBe(false)
    expect(claudeTrusts(text, ['/'])).toBe(false)
    expect(claudeTrusts('not json', ['/repo'])).toBe(false)
  })

  it('adds one claude entry with claude’s own defaults and keeps the rest byte for byte', () => {
    const text = claudeConfig(['/repo'])
    const next = withClaudeTrust(text, '/wt') as string
    const parsed = JSON.parse(next) as { projects: Record<string, Record<string, unknown>> }
    expect(parsed.projects['/wt']?.hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects['/wt']?.allowedTools).toEqual([])
    const { '/wt': _added, ...rest } = parsed.projects
    expect(JSON.stringify({ ...parsed, projects: rest }, null, 2)).toBe(text)
    expect(withClaudeTrust(next, '/wt')).toBeNull()
  })

  it('reads codex tables in either quoting and never an untrusted one', () => {
    const text = codexConfig(['/repo']) + '[projects.\'/single\']\ntrust_level = "trusted"\n'
    expect(codexTrusts(text, ['/repo'])).toBe(true)
    expect(codexTrusts(text, ['/single'])).toBe(true)
    expect(codexTrusts(text, ['/elsewhere'])).toBe(false)
  })

  it('appends one codex table after the file as it was', () => {
    const text = codexConfig(['/repo'])
    const next = withCodexTrust(text, '/wt') as string
    expect(next.startsWith(text)).toBe(true)
    expect(next.slice(text.length)).toBe('\n[projects."/wt"]\ntrust_level = "trusted"\n')
    expect(codexTrusts(next, ['/wt'])).toBe(true)
  })

  it('leaves codex alone when the folder is named already or projects is an inline table', () => {
    expect(withCodexTrust(codexConfig(['/repo']), '/elsewhere')).toBeNull()
    expect(withCodexTrust('projects = { "/repo" = { trust_level = "trusted" } }\n', '/wt')).toBeNull()
  })
})

describe('trusting a new worktree', () => {
  it('trusts it in each CLI that trusts the main checkout, keeping one first backup', async () => {
    const w = await world()
    const claudeBefore = claudeConfig([w.main])
    const codexBefore = codexConfig([w.main])
    await writeFile(w.claudeFile, claudeBefore, { mode: 0o600 })
    await writeFile(w.codexFile, codexBefore, { mode: 0o600 })

    const written = await trustNewWorktree({ mainCheckout: w.main, worktree: w.worktree, env: w.env, home: w.home })

    expect(written).toEqual([w.claudeFile, w.codexFile])
    expect(claudeTrusts(await readFile(w.claudeFile, 'utf8'), [w.worktree])).toBe(true)
    expect(codexTrusts(await readFile(w.codexFile, 'utf8'), [w.worktree])).toBe(true)
    expect((await stat(w.claudeFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(`${w.claudeFile}.teamree-backup`, 'utf8')).toBe(claudeBefore)
    expect(await readFile(`${w.codexFile}.teamree-backup`, 'utf8')).toBe(codexBefore)
    expect((await stat(`${w.claudeFile}.teamree-backup`)).mode & 0o777).toBe(0o600)

    const second = path.join(path.dirname(w.worktree), 'second')
    await mkdir(second)
    await trustNewWorktree({ mainCheckout: w.main, worktree: second, env: w.env, home: w.home })
    expect(await readFile(`${w.claudeFile}.teamree-backup`, 'utf8')).toBe(claudeBefore)
    expect(claudeTrusts(await readFile(w.claudeFile, 'utf8'), [second])).toBe(true)
  })

  it('writes nothing when the main checkout is not trusted', async () => {
    const w = await world()
    await writeFile(w.claudeFile, claudeConfig([]))
    await writeFile(w.codexFile, codexConfig([]))
    const before = [await stat(w.claudeFile), await stat(w.codexFile)]

    expect(await trustNewWorktree({ mainCheckout: w.main, worktree: w.worktree, env: w.env, home: w.home })).toEqual([])
    const after = [await stat(w.claudeFile), await stat(w.codexFile)]
    expect(after.map((file) => file.mtimeMs)).toEqual(before.map((file) => file.mtimeMs))
    expect(existsSync(`${w.claudeFile}.teamree-backup`)).toBe(false)
  })

  it('creates no config file a CLI never wrote', async () => {
    const w = await world()
    expect(await trustNewWorktree({ mainCheckout: w.main, worktree: w.worktree, env: w.env, home: w.home })).toEqual([])
    expect(existsSync(w.claudeFile)).toBe(false)
    expect(existsSync(w.codexFile)).toBe(false)
  })

  it('waits for claude’s own lock, and skips claude while it is held', async () => {
    const w = await world()
    await writeFile(w.claudeFile, claudeConfig([w.main]))
    await writeFile(w.codexFile, codexConfig([w.main]))
    await mkdir(`${w.claudeFile}.lock`)

    const held = await trustNewWorktree({
      mainCheckout: w.main,
      worktree: w.worktree,
      env: w.env,
      home: w.home,
      lockWaitMs: 100
    })
    expect(held).toEqual([w.codexFile])
    expect(claudeTrusts(await readFile(w.claudeFile, 'utf8'), [w.worktree])).toBe(false)

    setTimeout(() => void rmdir(`${w.claudeFile}.lock`), 100)
    const released = await trustNewWorktree({ mainCheckout: w.main, worktree: w.worktree, env: w.env, home: w.home })
    expect(released).toEqual([w.claudeFile])
    expect(existsSync(`${w.claudeFile}.lock`)).toBe(false)
  })

  it('writes through a symlinked config and leaves the link in place', async () => {
    const w = await world()
    const target = path.join(w.env.CLAUDE_CONFIG_DIR, 'dotfiles.json')
    await writeFile(target, claudeConfig([w.main]))
    await symlink(target, w.claudeFile)

    await trustNewWorktree({ mainCheckout: w.main, worktree: w.worktree, env: w.env, home: w.home })

    expect(await realpath(w.claudeFile)).toBe(target)
    expect(claudeTrusts(await readFile(target, 'utf8'), [w.worktree])).toBe(true)
  })
})

describe('rewriting a config another program also writes', () => {
  it('reads again when the file changed between read and rename', async () => {
    const w = await world()
    await writeFile(w.codexFile, 'a = 1\n')
    let calls = 0
    const wrote = await rewriteConfig(w.codexFile, (text) => {
      calls += 1
      // Another writer lands between this read and the rename.
      if (calls === 1) writeFileSync(w.codexFile, 'a = 1\nb = 2\n')
      return `${text}c = 3\n`
    })
    expect(wrote).toBe(true)
    expect(calls).toBe(2)
    expect(await readFile(w.codexFile, 'utf8')).toBe('a = 1\nb = 2\nc = 3\n')
  })

  it('gives up after one retry rather than overwrite a busy file', async () => {
    const w = await world()
    await writeFile(w.codexFile, 'a = 1\n')
    let n = 0
    const wrote = await rewriteConfig(w.codexFile, (text) => {
      n += 1
      writeFileSync(w.codexFile, `${text}x${n} = 1\n`)
      return `${text}c = 3\n`
    })
    expect(wrote).toBe(false)
    expect(await readFile(w.codexFile, 'utf8')).not.toContain('c = 3')
  })
})
